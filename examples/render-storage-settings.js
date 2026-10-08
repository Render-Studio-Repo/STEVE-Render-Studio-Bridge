/**
 * Mount Fusion storage settings with an authenticated client.storage(payload).
 * Returns cleanup immediately; in-flight requests cannot be cancelled, but their
 * results are ignored after cleanup. Browsing never changes the saved destination.
 * Optional fusionIntegration supplies getStatus() and connect(); the host owns
 * authentication. Its cloud connection does not gate the local Fusion picker.
 */
export function mountSteveStorageSettings(root, client, { fusionIntegration } = {}) {
  if (!root?.ownerDocument || typeof client?.storage !== 'function') {
    throw new TypeError('A DOM root and a storage client are required.');
  }
  const document = root.ownerDocument;
  const node = (tag, text) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (text) => {
    const element = node('button', text);
    element.type = 'button';
    element.className = 'btn secondary';
    return element;
  };
  const label = (text, control) => {
    const element = node('label', text);
    element.append(control);
    return element;
  };
  const section = node('section');
  section.setAttribute('aria-label', 'Fusion autosave settings');
  section.style.display = 'grid';
  section.style.gap = '0.75rem';
  const checkbox = node('input');
  checkbox.type = 'checkbox';
  const savedLocation = node('p');
  const projects = node('select');
  const folders = node('select');
  const browseLocation = node('p');
  const open = button('Open selected subfolder');
  const back = button('Parent folder');
  const save = button('Use this folder');
  const current = button('Use current Fusion Data Panel folder');
  const choose = button('Choose folder in Fusion…');
  const integrationStatus = node('p');
  integrationStatus.setAttribute('role', 'status');
  const connect = button('Connect Fusion integration');
  const retryConnection = button('Retry connection status');
  const retry = button('Retry');
  const status = node('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const warning = node('p');
  const limits = node('p');
  section.append(
    node('h3', 'Fusion autosave'),
    integrationStatus, connect, retryConnection,
    label('Automatically save successful STEVE requests ', checkbox),
    savedLocation,
    label('Fusion project ', projects),
    browseLocation,
    label('Fusion subfolder ', folders),
    open, back, save, choose, current, status, retry, warning, limits,
    node('p', 'New documents use the saved destination. Existing documents save in place. '
      + 'The current Fusion Data Panel folder is captured when each request starts.')
  );
  root.replaceChildren(section);

  let disposed = false;
  let busy = false;
  let settings = null;
  let selected = null;
  let parents = [];
  let savedName = '';
  let projectList = [];
  let retryAction = null;
  let nativeFolderPicker = false;
  let connectionBusy = false;
  const controls = [checkbox, projects, folders, open, back, save, choose, current,
    retry, connect, retryConnection];
  integrationStatus.hidden = connect.hidden = retryConnection.hidden = true;

  const sameDestination = (a, b) => a && b
    && a.projectId === b.projectId && a.folderId === b.folderId;
  const nameOf = (value) => `${value.project.name} / ${value.folder.name}`;
  const destinationOf = (value) => ({
    projectId: value.project.id, folderId: value.folder.id
  });
  const options = (select, entries, emptyText) => {
    const values = entries.length ? entries : [{ id: '', name: emptyText }];
    select.replaceChildren(...values.map((entry) => {
      const option = node('option', entry.name);
      option.value = entry.id;
      return option;
    }));
  };
  const render = () => {
    if (disposed) return;
    section.setAttribute('aria-busy', String(busy));
    checkbox.checked = settings?.autoSave ?? false;
    checkbox.disabled = busy || !settings;
    projects.disabled = busy || !settings || !projectList.length;
    folders.disabled = busy || !selected || !folders.value;
    open.disabled = folders.disabled;
    back.disabled = busy || !parents.length;
    save.disabled = busy || !settings || !selected;
    current.disabled = busy || !settings;
    choose.hidden = !nativeFolderPicker;
    choose.disabled = busy || !settings || !nativeFolderPicker;
    retry.hidden = !retryAction;
    retry.disabled = busy || !retryAction;
    projects.value = selected?.projectId ?? '';
    browseLocation.textContent = selected
      ? `Browsing: ${selected.name}` : 'Browsing: no folder selected.';
    savedLocation.textContent = !settings ? 'Saved destination: not loaded.'
      : !settings.projectId && !settings.folderId
        ? 'Saved destination: current Fusion Data Panel folder (at request start).'
        : `Saved destination: ${savedName || `Project ${settings.projectId ?? '(unspecified)'}, folder ${settings.folderId ?? '(project root)'}`}`;
  };
  const request = async (payload) => {
    const result = await client.storage(payload);
    if (disposed) throw new Error('Storage settings unmounted.');
    return result;
  };
  const readSettings = (value) => {
    if (!value || typeof value.autoSave !== 'boolean'
      || ![value.projectId, value.folderId].every((id) => id === null || typeof id === 'string')) {
      throw new Error('Fusion returned invalid storage settings.');
    }
    return { autoSave: value.autoSave, projectId: value.projectId, folderId: value.folderId };
  };
  // Serializing every operation also prevents older responses overwriting newer UI.
  async function work(action, pendingText) {
    if (disposed || busy) return;
    busy = true;
    retryAction = null;
    status.textContent = pendingText;
    render();
    try {
      const successText = await action();
      if (!disposed) status.textContent = successText ?? 'Storage settings are up to date.';
    } catch (error) {
      if (!disposed) {
        retryAction = () => work(action, pendingText);
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    } finally {
      busy = false;
      render();
    }
  }
  async function browse(projectId, folderId, nextParents) {
    const result = await request({ action: 'folders', projectId, folderId });
    if (!result?.project?.id || !result?.folder?.id || !Array.isArray(result.folders)) {
      throw new Error('Fusion returned an invalid folder listing.');
    }
    // Commit the location and history together only after the request succeeds.
    selected = { ...destinationOf(result), name: nameOf(result) };
    parents = nextParents;
    options(folders, result.folders, 'No subfolders');
    if (!projectList.some((project) => project.id === result.project.id)) {
      projectList = [...projectList, result.project];
      options(projects, projectList, 'No accessible projects');
    }
    if (sameDestination(settings, selected)) savedName = selected.name;
  }
  async function persist(nextSettings, nextName) {
    const result = await request({ action: 'setSettings', ...nextSettings });
    settings = readSettings(result);
    savedName = sameDestination(settings, nextSettings) ? nextName : '';
    warning.textContent = '';
  }
  async function initialize() {
    const result = await request({ action: 'getSettings' });
    settings = readSettings(result);
    savedName = '';
    nativeFolderPicker = result.nativeFolderPicker === true;
    warning.textContent = result.configError || '';
    const quota = result.limits;
    limits.textContent = quota?.limited
      ? `${quota.editableCount}/${quota.maximum} documents editable.` : '';
    if (quota?.limited && quota.editableCount >= quota.maximum) {
      limits.textContent += quota.oldestEligible
        ? ` Make ${quota.oldestEligible.name} Read-only in Fusion to free an editable slot.`
        : ' No closed, unused editable file is eligible to be made Read-only.';
    }
    const listing = await request({ action: 'projects' });
    if (!Array.isArray(listing?.projects)) throw new Error('Fusion returned an invalid project listing.');
    projectList = listing.projects;
    selected = null;
    parents = [];
    options(projects, projectList, 'No accessible projects');
    options(folders, [], 'No subfolders');
    if (settings.projectId || settings.folderId) {
      await browse(settings.projectId, settings.folderId, []);
    } else if (projectList.length) {
      await browse(projectList[0].id, null, []);
    }
  }

  // Cloud integration status is independent of Fusion's local login and picker.
  async function checkConnection() {
    if (disposed || connectionBusy || !fusionIntegration) return;
    connectionBusy = true;
    integrationStatus.hidden = false;
    integrationStatus.textContent = 'Checking Fusion integration connection…';
    connect.hidden = true;
    retryConnection.hidden = true;
    try {
      const result = await fusionIntegration.getStatus();
      if (disposed) return;
      if (typeof result?.linked !== 'boolean') {
        throw new Error('Invalid Fusion integration connection status.');
      }
      const account = [result.autodesk_name, result.autodesk_email]
        .filter((value) => typeof value === 'string' && value.trim()).join(' — ');
      integrationStatus.textContent = result.linked
        ? `Fusion integration connected${account ? `: ${account}` : '.'}`
        : 'Fusion integration is not connected.';
      connect.hidden = result.linked;
    } catch (error) {
      if (!disposed) {
        integrationStatus.textContent = `Could not check Fusion integration connection: ${error instanceof Error ? error.message : String(error)}`;
        retryConnection.hidden = false;
      }
    } finally {
      connectionBusy = false;
    }
  }
  connect.onclick = async () => {
    if (disposed || connectionBusy || !fusionIntegration) return;
    connectionBusy = true;
    connect.disabled = true;
    try {
      await fusionIntegration.connect();
      if (!disposed) {
        integrationStatus.textContent = 'Complete the Fusion integration connection, then retry connection status.';
        retryConnection.hidden = false;
      }
    } catch (error) {
      if (!disposed) {
        integrationStatus.textContent = `Could not connect Fusion integration: ${error instanceof Error ? error.message : String(error)}`;
        retryConnection.hidden = false;
      }
    } finally {
      connectionBusy = false;
      if (!disposed) connect.disabled = false;
    }
  };
  retryConnection.onclick = () => { void checkConnection(); };
  choose.onclick = () => {
    if (!settings || !nativeFolderPicker) return;
    const requestId = globalThis.crypto.randomUUID();
    void work(async () => {
      const result = await client.storage({ action: 'chooseFolder' }, { requestId });
      if (disposed) return;
      if (result?.cancelled === true) return 'Folder selection cancelled.';
      if (result?.cancelled !== false || !result.project?.id || !result.folder?.id) {
        throw new Error('Fusion returned an invalid folder selection.');
      }
      await browse(result.project.id, result.folder.id, []);
      return 'Folder selected; click Use this folder to save it.';
    }, 'Switch to Fusion to choose a folder');
  };
  checkbox.onchange = () => {
    if (!settings || busy || disposed) { render(); return; }
    const next = { ...settings, autoSave: checkbox.checked };
    const name = savedName;
    void work(() => persist(next, name), 'Saving autosave preference…');
  };
  projects.onchange = () => {
    const projectId = projects.value;
    if (projectId) void work(() => browse(projectId, null, []), 'Loading project…');
  };
  folders.onchange = render;
  open.onclick = () => {
    if (!selected || !folders.value) return;
    const projectId = selected.projectId;
    const folderId = folders.value;
    const history = [...parents, selected];
    void work(() => browse(projectId, folderId, history), 'Loading subfolder…');
  };
  back.onclick = () => {
    const parent = parents[parents.length - 1];
    if (!parent) return;
    const history = parents.slice(0, -1);
    void work(() => browse(parent.projectId, parent.folderId, history), 'Loading parent folder…');
  };
  save.onclick = () => {
    if (!settings || !selected) return;
    const next = { autoSave: settings.autoSave, projectId: selected.projectId, folderId: selected.folderId };
    const name = selected.name;
    void work(() => persist(next, name), 'Saving destination…');
  };
  current.onclick = () => {
    if (!settings) return;
    const next = { autoSave: settings.autoSave, projectId: null, folderId: null };
    void work(() => persist(next, ''), 'Saving Data Panel default…');
  };
  retry.onclick = () => { if (retryAction) void retryAction(); };
  void work(initialize, 'Loading storage settings…');
  void checkConnection();

  return () => {
    disposed = true;
    retryAction = null;
    for (const control of controls) {
      control.onclick = null;
      control.onchange = null;
    }
    section.remove();
  };
}
