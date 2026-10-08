from pathlib import Path
import tempfile
from types import SimpleNamespace as O
from unittest.mock import Mock, patch
import unittest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'addin/STEVE'))
from steve.render_feed import RenderFeed
from steve.render_storage import RenderStorage

class Collection:
    def __init__(self, values): self.values=values
    @property
    def count(self): return len(self.values)
    def item(self,i): return self.values[i]
    def itemById(self,id): return next((x for x in self.values if x.id==id),None)

class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.project=O(id='project',name='Robots')
        self.folder=O(id='folder',name='Render',parentProject=self.project,isValid=True,dataFolders=Collection([]))
        self.project.rootFolder=self.folder
        self.doc=O(isSaved=False,isValid=True,isModified=True,name='Bracket',dataFile=None,saveAs=Mock(return_value=True),save=Mock(return_value=True))
        self.app=O(data=O(personalUseLimits=None,activeFolder=self.folder,activeProject=self.project,activeHub=O(id='hub',name='Hub'),dataProjects=Collection([self.project]),findFolderById=lambda id:self.folder if id=='folder' else None),documents=Collection([self.doc]),activeDocument=self.doc,userInterface=O(activeCommand='SelectCommand'))
        self.feed=RenderFeed();self.feed.accept('request','Create a bracket')
        self.storage=RenderStorage(self.app,self.feed,Path(self.temp.name)/'settings.json',Mock())
        self.submission=O(request_id='request',project_id=None,folder_id=None,design_name='Motor bracket')
    def start(self):
        self.storage.track(self.submission,self.doc)
        state=self.storage.decorate({'bridgeRequestId':'request','busy':False,'status':'Ready'})
        self.feed.observe(state)
        self.assertTrue(state['bridgeSaving'])
    def savedfile(self):
        return O(id='file',name='Bracket',isComplete=True,isReadOnly=False,parentFolder=self.folder,parentProject=self.project)
    def test_new_doc_uses_pinned_folder_and_waits_for_upload(self):
        self.start();self.app.data.activeFolder=None
        self.storage.run_main()
        self.doc.saveAs.assert_called_once_with('Motor bracket',self.folder,'Created with Render Studio / STEVE','')
        self.assertEqual(self.feed.read('request',0)['snapshot']['phase'],'saving')
        self.doc.dataFile=self.savedfile();self.doc.isSaved=True;self.storage.jobs['request']['next']=0
        self.storage.run_main()
        self.assertEqual(self.feed.read('request',0)['snapshot']['save']['state'],'saved')
        self.assertFalse(self.storage.saving())
    def test_existing_document_saves_in_place(self):
        self.doc.isSaved=True;self.doc.dataFile=self.savedfile()
        self.start();self.storage.run_main()
        self.doc.save.assert_called_once();self.doc.saveAs.assert_not_called()
    def test_limit_recommends_oldest_closed_unused_file_and_retries(self):
        files=[O(id='busy',name='Busy',dateModified=1,isInUse=True,isReadOnly=False),O(id='old',name='Old',dateModified=2,isInUse=False,isReadOnly=False),O(id='new',name='New',dateModified=3,isInUse=False,isReadOnly=False)]
        self.app.data.personalUseLimits=O(editableFiles=files,editableFileCount=10,maxEditableFileCount=10)
        self.start();self.storage.run_main()
        save=self.feed.read('request',0)['snapshot']['save']
        self.assertEqual(save['oldestEligible']['id'],'old');self.assertFalse(save['canAutoMakeReadOnly'])
        self.doc.saveAs.assert_not_called()
        self.app.data.personalUseLimits.editableFileCount=9;self.storage.jobs['request']['next']=0
        self.storage.run_main();self.doc.saveAs.assert_called_once()
    def test_settings_persist_and_invalid_folder_does_not_replace(self):
        self.storage.handle({'action':'setSettings','autoSave':True,'projectId':'project','folderId':'folder'})
        other=RenderStorage(self.app,self.feed,self.storage.path,Mock())
        self.assertEqual(other.settings['folderId'],'folder')
        with self.assertRaises(ValueError): self.storage.handle({'action':'setSettings','autoSave':True,'folderId':'missing'})
        self.assertEqual(self.storage.settings['folderId'],'folder')
        with self.assertRaises(ValueError): self.storage.folder('wrong','folder')

    def test_native_picker_selection_cancel_and_modal_reentry(self):
        core=O(DialogResults=O(DialogOK=1))
        dialog=O(dataFolder=self.folder,showDialog=Mock(return_value=1))
        self.app.userInterface.createCloudFolderDialog=lambda:dialog
        before=dict(self.storage.settings)
        self.assertTrue(self.storage.handle({'action':'getSettings'})['nativeFolderPicker'])
        with patch.dict(sys.modules,{'adsk':O(core=core),'adsk.core':core}):
            result=self.storage.handle({'action':'chooseFolder'})
            self.assertEqual(result['folder']['id'],'folder')
            self.assertEqual(self.storage.settings,before)
            dialog.showDialog.return_value=0
            self.assertEqual(self.storage.handle({'action':'chooseFolder'}),{'cancelled':True})
            self.assertEqual(self.storage.settings,before)
            self.storage.dialog_open=True
            self.storage.submit('rpc',{'action':'projects'})
            self.storage.run_main()
            self.assertTrue(self.storage.result('rpc')['pending'])
            self.assertTrue(self.storage.saving())

    def test_native_picker_does_not_open_during_modeling(self):
        self.app.userInterface.createCloudFolderDialog=Mock()
        self.storage.submit('picker',{'action':'chooseFolder'})
        self.storage.run_main(allow_save=False)
        self.assertIn('finish',self.storage.result('picker')['error'])
        self.app.userInterface.createCloudFolderDialog.assert_not_called()

    def test_native_picker_exception_releases_modal_guard(self):
        core=O(DialogResults=O(DialogOK=1))
        self.app.userInterface.createCloudFolderDialog=Mock(side_effect=RuntimeError('dialog failed'))
        with patch.dict(sys.modules,{'adsk':O(core=core),'adsk.core':core}):
            with self.assertRaises(RuntimeError):self.storage.handle({'action':'chooseFolder'})
        self.assertFalse(self.storage.dialog_open)
    def test_switching_document_or_active_command_defers_save(self):
        self.start();self.app.activeDocument=O();self.storage.run_main();self.doc.saveAs.assert_not_called()
        self.app.activeDocument=self.doc;self.app.userInterface.activeCommand='Extrude';self.storage.jobs['request']['next']=0
        self.storage.run_main();self.doc.saveAs.assert_not_called()
    def test_failure_and_retry(self):
        self.doc.saveAs.return_value=False;self.start();self.storage.run_main()
        self.assertEqual(self.feed.read('request',0)['snapshot']['phase'],'failed')
        self.storage.handle({'action':'retrySave','requestId':'request'});self.doc.saveAs.return_value=True
        self.storage.run_main();self.assertEqual(self.doc.saveAs.call_count,2)
    def test_rpc_idempotence_and_main_thread_queue(self):
        self.assertTrue(self.storage.submit('rpc',{'action':'projects'})['pending'])
        self.storage.submit('rpc',{'action':'projects'})
        with self.assertRaises(ValueError): self.storage.submit('rpc',{'action':'folders'})
        self.assertEqual(len(self.storage.queue),1);self.storage.run_main()
        self.assertEqual(self.storage.result('rpc')['result']['projects'][0]['name'],'Robots')
    def test_disabled_failed_stopped_and_queued_requests_do_not_save(self):
        self.storage.settings['autoSave']=False;self.storage.track(self.submission,self.doc)
        self.assertFalse(self.storage.jobs)
        self.storage.settings['autoSave']=True;self.storage.track(self.submission,self.doc)
        self.storage.decorate({'bridgeRequestId':'request','bridgeSendQueued':True})
        self.storage.run_main();self.doc.saveAs.assert_not_called()
        self.storage.decorate({'bridgeRequestId':'request','error':'Failed'})
        self.storage.run_main();self.doc.saveAs.assert_not_called()
    def test_closed_document_fails_instead_of_saving_current(self):
        self.start();self.doc.isValid=False;self.storage.run_main()
        self.assertEqual(self.feed.read('request',0)['snapshot']['phase'],'failed')
        self.doc.saveAs.assert_not_called()
    def test_autosave_waits_until_controller_is_idle(self):
        self.start();self.storage.run_main(allow_save=False)
        self.doc.saveAs.assert_not_called()
        self.storage.run_main();self.doc.saveAs.assert_called_once()

    def test_schematic_default_selection_does_not_block_save(self):
        self.app.userInterface.activeCommand='Electron::Group'
        self.app.userInterface.activeWorkspace=O(id='SchEditorEnvironement')
        self.app.activeProduct=O(productType='SchematicProductType')
        self.start();self.storage.run_main();self.doc.saveAs.assert_called_once()

    def test_electronics_edit_command_still_defers_save(self):
        self.app.userInterface.activeCommand='Electron::Wire'
        self.app.userInterface.activeWorkspace=O(id='SchEditorEnvironement')
        self.app.activeProduct=O(productType='SchematicProductType')
        self.start();self.storage.run_main();self.doc.saveAs.assert_not_called()
    def test_changed_saved_folder_is_reported_without_moving(self):
        self.start();self.doc.isSaved=True;self.doc.dataFile=self.savedfile()
        self.doc.dataFile.parentFolder=O(id='other',name='Other')
        self.storage.run_main()
        self.assertEqual(self.feed.read('request',0)['snapshot']['phase'],'failed')
        self.doc.save.assert_not_called();self.doc.saveAs.assert_not_called()

    def test_save_status_is_not_completed_until_cloud_confirmation(self):
        self.start();self.storage.run_main()
        self.feed.observe(self.storage.decorate({'bridgeRequestId':'request','status':'Ready'}))
        self.assertEqual(self.feed.read('request',0)['snapshot']['phase'],'saving')

if __name__=='__main__':unittest.main()
