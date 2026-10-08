"""Fusion-main-thread storage operations and completion autosave for Render jobs."""
from collections import OrderedDict, deque
from pathlib import Path
import json
import threading
import time

from .update_transaction import write_json


def entries(collection):
    if isinstance(collection, (list, tuple)):
        return collection
    return [collection.item(i) for i in range(collection.count)]


def info(obj):
    return {"id": obj.id, "name": obj.name}


class RenderStorage:
    def __init__(self, app, feed, path, wake):
        self.app, self.feed, self.path, self.wake = app, feed, Path(path), wake
        self.lock = threading.RLock()
        self.operations = OrderedDict()
        self.queue = deque()
        self.jobs = OrderedDict()
        self.dialog_open = False
        self.settings = {"autoSave": True, "projectId": None, "folderId": None}
        self.config_error = ""
        try:
            saved = json.loads(self.path.read_text())
            if type(saved.get('autoSave')) is not bool:
                raise ValueError('Invalid autosave setting')
            for key in ('projectId', 'folderId'):
                if saved.get(key) is not None and not isinstance(saved[key], str):
                    raise ValueError('Invalid destination')
            self.settings.update({k: saved.get(k) for k in self.settings})
        except FileNotFoundError:
            pass
        except (ValueError, TypeError, AttributeError, OSError):
            self.settings['autoSave'] = False
            self.config_error = 'Saved storage settings could not be read. Select a destination and save settings again.'

    def submit(self, request_id, payload):
        encoded = json.dumps(payload, sort_keys=True)
        with self.lock:
            prior = self.operations.get(request_id)
            if prior:
                if prior['body'] != encoded:
                    raise ValueError('Storage request ID already used with different content.')
                return self.result(request_id)
            if len(self.queue) >= 16:
                raise ValueError('Storage queue is full; retry later.')
            self.operations[request_id] = {'body': encoded, 'pending': True}
            self.queue.append((request_id, payload))
            for key in list(self.operations):
                if len(self.operations) <= 128:
                    break
                # Claimed work is no longer in queue. Keep its pending result as
                # the bridge's reservation until run_main publishes completion.
                if not self.operations[key]['pending']:
                    self.operations.pop(key)
        self.wake()
        return {'requestId': request_id, 'pending': True}

    def connection_busy(self):
        """Include claimed operations before connection-scoped cache removal."""
        with self.lock:
            return (self.dialog_open or any(op['pending'] for op in self.operations.values())
                    or any(job['state'] in {'running', 'pending', 'uploading'} for job in self.jobs.values()))

    def clear_connection(self):
        """Forget completed connection metadata; never close or mutate documents.

        The bridge checks connection_busy before committing the origin change
        and holds its admission/queue locks throughout that transaction.
        """
        with self.lock:
            self.operations.clear()
            self.queue.clear()
            self.jobs.clear()

    def result(self, request_id):
        with self.lock:
            value = self.operations.get(request_id)
            if value is None:
                raise ValueError('Storage request not found or expired.')
            return {'requestId': request_id, **{k: v for k, v in value.items() if k != 'body'}}

    def folder(self, project_id=None, folder_id=None):
        data = self.app.data
        if folder_id:
            folder = data.findFolderById(folder_id)
            if folder is None or not folder.isValid:
                raise ValueError('The chosen Fusion folder is missing or inaccessible.')
            if project_id and folder.parentProject.id != project_id:
                raise ValueError('Folder does not belong to the chosen Fusion project.')
            return folder
        if project_id:
            project = data.dataProjects.itemById(project_id)
            if project is None:
                raise ValueError('Choose a project accessible in the current Fusion hub.')
            return project.rootFolder
        folder = data.activeFolder
        if folder is None:
            project = data.activeProject
            folder = project.rootFolder if project else None
        if folder is None:
            raise ValueError('Choose a Fusion project and folder before generating a new document.')
        return folder

    def limits(self):
        limits = self.app.data.personalUseLimits
        if limits is None:
            return {'limited': False, 'canAutoMakeReadOnly': False}
        opened = {d.dataFile.id for d in entries(self.app.documents) if d.dataFile is not None}
        candidates = []
        for file in limits.editableFiles:
            if file.id not in opened and not file.isInUse and not file.isReadOnly:
                candidates.append({**info(file), 'dateModified': file.dateModified})
        candidates.sort(key=lambda f: (f['dateModified'], f['id']))
        return {'limited': True, 'editableCount': limits.editableFileCount,
                'maximum': limits.maxEditableFileCount, 'canAutoMakeReadOnly': False,
                'oldestEligible': candidates[0] if candidates else None,
                'instruction': 'In Fusion, set this file to Read-only in My Editable Documents. Autosave will retry. No files are deleted.'}

    def handle(self, payload):
        action = payload.get('action')
        if action == 'getSettings':
            return {**self.settings, 'configError': self.config_error, 'limits': self.limits(),
                    'nativeFolderPicker': callable(getattr(self.app.userInterface, 'createCloudFolderDialog', None))}
        if action == 'chooseFolder':
            ui = self.app.userInterface
            create_dialog = getattr(ui, 'createCloudFolderDialog', None)
            if not callable(create_dialog):
                raise ValueError('Update Fusion to use its cloud folder picker, or use the project and folder lists.')
            if self.dialog_open or self.saving() or ui.activeCommand not in {'', 'SelectCommand'}:
                raise ValueError('Finish the active Fusion command or save before choosing a folder.')
            import adsk.core
            self.dialog_open = True
            try:
                dialog = create_dialog()
                dialog.title = 'Choose Render Studio autosave folder'
                try:
                    dialog.initialFolder = self.folder(self.settings['projectId'], self.settings['folderId'])
                except ValueError:
                    pass  # Let the native dialog recover an inaccessible saved destination.
                if dialog.showDialog() != adsk.core.DialogResults.DialogOK:
                    return {'cancelled': True}
                folder = dialog.dataFolder
                if folder is None or not folder.isValid:
                    raise ValueError('Fusion did not return an accessible cloud folder.')
                return {'cancelled': False, 'project': info(folder.parentProject), 'folder': info(folder)}
            finally:
                self.dialog_open = False
        if action == 'projects':
            return {'hub': info(self.app.data.activeHub), 'projects': [info(p) for p in entries(self.app.data.dataProjects)]}
        if action == 'folders':
            folder = self.folder(payload.get('projectId'), payload.get('folderId'))
            return {'folder': info(folder), 'project': info(folder.parentProject),
                    'folders': [info(f) for f in entries(folder.dataFolders)]}
        if action == 'setSettings':
            if type(payload.get('autoSave')) is not bool:
                raise ValueError('autoSave must be true or false.')
            project_id, folder_id = payload.get('projectId'), payload.get('folderId')
            folder = self.folder(project_id, folder_id) if project_id or folder_id else None
            settings = {'autoSave': payload['autoSave'], 'projectId': folder.parentProject.id if folder else None,
                        'folderId': folder.id if folder else None}
            self.path.parent.mkdir(parents=True, exist_ok=True)
            write_json(self.path, settings)
            self.settings, self.config_error = settings, ''
            return {**settings, 'destination': info(folder) if folder else None}
        if action == 'retrySave':
            with self.lock:
                job = self.jobs.get(payload.get('requestId'))
                if not job or job['state'] != 'failed':
                    raise ValueError('No failed save available for that request.')
                job.update(state='pending', next=0)
                self.feed.save_status(payload['requestId'], {'state':'pending'}, 'saving')
            return {'retrying': True}
        raise ValueError('Unsupported storage action.')

    def track(self, submission, document):
        # Called during Send context capture, before the controller worker starts.
        if not self.settings['autoSave']:
            return
        if document is None or not document.isValid:
            raise ValueError('Open the intended Fusion document before sending an autosaved request.')
        project_id = submission.project_id if submission.project_id or submission.folder_id else self.settings['projectId']
        folder_id = submission.folder_id if submission.project_id or submission.folder_id else self.settings['folderId']
        folder = self.folder(project_id, folder_id) if not document.isSaved else None
        with self.lock:
            self.jobs[submission.request_id] = {'document': document, 'folder': folder,
                'name': submission.design_name, 'state': 'running', 'next': 0}
            # Never evict a pending save; the command queue waits for these to finish.
            for key in list(self.jobs):
                if len(self.jobs) <= 64: break
                if self.jobs[key]['state'] in {'done','failed','cancelled'}: self.jobs.pop(key)

    def decorate(self, state):
        with self.lock:
            job = self.jobs.get(state.get('bridgeRequestId'))
            if job and job['state'] == 'running' and not state.get('busy') and not state.get('jobBusy') and not state.get('bridgeSendQueued'):
                if state.get('error') or state.get('status') == 'Stopped':
                    job['state'] = 'cancelled'
                else:
                    job['state'] = 'pending'
            if job and job['state'] in {'pending','uploading'}:
                return {**state, 'bridgeSaving': True}
        return state

    def pending(self):
        with self.lock:
            return bool(self.queue) or any(j['state'] in {'pending','uploading'} for j in self.jobs.values())

    def saving(self):
        with self.lock:
            return self.dialog_open or any(j['state'] in {'pending','uploading'} for j in self.jobs.values())

    def run_main(self, allow_save=True):
        # This method alone touches Autodesk objects, always on Fusion's main thread.
        if self.dialog_open:
            return  # Modal dialogs pump events; never re-enter this queue while one is open.
        with self.lock:
            work = list(self.queue); self.queue.clear()
        for request_id, payload in work:
            try:
                if payload.get('action') == 'chooseFolder' and not allow_save:
                    raise ValueError('Wait for the current STEVE request to finish before opening the folder picker.')
                result = {'pending': False, 'result': self.handle(payload)}
            except Exception as error:
                result = {'pending': False, 'error': str(error)[:2000]}
            with self.lock:
                self.operations[request_id].update(result)
        if not allow_save:
            return
        with self.lock:
            jobs = list(self.jobs.items())
        for request_id, job in jobs:
            if job['state'] not in {'pending','uploading'} or time.monotonic() < job['next']:
                continue
            job['next'] = time.monotonic() + 5
            try:
                doc = job['document']
                if not doc.isValid:
                    raise ValueError('The autosave document was closed. Reopen it and save manually.')
                if job['state'] == 'uploading':
                    file = doc.dataFile
                    if file and file.isComplete:
                        job['state'] = 'done'
                        self.feed.save_status(request_id, {'state':'saved', 'file':info(file),
                            'folder':info(file.parentFolder), 'project':info(file.parentProject)}, 'completed')
                    elif time.monotonic() - job['uploadStarted'] > 180:
                        raise ValueError('Cloud save has not confirmed completion. Check Fusion cloud status before retrying.')
                    continue
                if self.app.activeDocument != doc:
                    self.feed.save_status(request_id, {'state':'waiting', 'message':'Activate '+doc.name+' in Fusion to autosave.'}, 'saving')
                    continue
                # Saving inside an active modeling command/transaction is not supported.
                ui = self.app.userInterface
                schematic_idle = (ui.activeCommand == 'Electron::Group'
                    and getattr(getattr(ui, 'activeWorkspace', None), 'id', None) == 'SchEditorEnvironement'
                    and getattr(getattr(self.app, 'activeProduct', None), 'productType', None) == 'SchematicProductType')
                if ui.activeCommand not in {'', 'SelectCommand'} and not schematic_idle:
                    self.feed.save_status(request_id, {'state':'waiting', 'message':'Finish the active Fusion command to autosave.'}, 'saving')
                    continue
                if not doc.isSaved:
                    limits = self.limits()
                    if limits.get('limited') and limits['editableCount'] >= limits['maximum']:
                        self.feed.save_status(request_id, {'state':'blocked', 'code':'editable_limit', **limits}, 'saving')
                        continue
                    folder = job['folder']
                    if not folder.isValid:
                        raise ValueError('The pinned save folder is no longer available.')
                    accepted = doc.saveAs(job['name'] or doc.name, folder, 'Created with Render Studio / STEVE', '')
                else:
                    file = doc.dataFile
                    if job['folder'] is not None and file.parentFolder.id != job['folder'].id:
                        raise ValueError('The document was saved outside the selected folder. It has not been moved automatically.')
                    if file.isReadOnly:
                        self.feed.save_status(request_id, {'state':'blocked', 'code':'read_only',
                            'message':'Make the target document editable in Fusion to save.'}, 'saving')
                        continue
                    if not doc.isModified and not file.isComplete:
                        job.update(state='uploading', uploadStarted=time.monotonic())
                        self.feed.save_status(request_id, {'state':'uploading'}, 'saving')
                        continue
                    if not doc.isModified:
                        job['state'] = 'done'
                        self.feed.save_status(request_id, {'state':'unchanged', 'file':info(file)}, 'completed')
                        continue
                    accepted = doc.save('Updated with Render Studio / STEVE')
                if not accepted:
                    raise ValueError('Fusion did not accept the save. Your document remains open; save manually or retry.')
                job.update(state='uploading', uploadStarted=time.monotonic())
                self.feed.save_status(request_id, {'state':'uploading'}, 'saving')
            except Exception as error:
                job['state'] = 'failed'
                self.feed.save_status(request_id, {'state':'failed', 'message':str(error)[:2000]}, 'failed')
