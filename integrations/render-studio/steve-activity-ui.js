import { steveProjectBinding, bindingOwns, bindingError } from './steve-project-binding.js?v=20261008-project-lock-p1';
import { SteveActivity, readSteveActivity } from './steve-activity.js?v=20261008-project-lock-p1';
import { SteveConnector } from './steve-connector.js?v=20261008-project-lock-p1';

export function mountSteveActivity({ host, getOwner, ingest, onAvailability, openProject, projectLabel = id => id, read, getProjects = () => [], bindingState = steveProjectBinding, projectConnector }) {
  if (!host) return null;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = '/cad/steve-activity.css?v=20261008-project-lock-p1'; document.head.append(link);
  const root = document.createElement('section'); root.className = 'steve-activity';
  root.setAttribute('aria-label', 'STEVE activity'); host.append(root);
  const cards = document.createElement('div'); cards.className = 'steve-activity-cards'; cards.setAttribute('aria-live', 'polite');
  const panel = document.createElement('section'); panel.className = 'steve-activity-chat'; panel.hidden = true;
  panel.setAttribute('aria-label', 'STEVE request conversation');
  root.append(panel, cards);
  const button = (label, action) => {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.addEventListener('click', action); return node;
  };
  const title = document.createElement('strong'), feed = document.createElement('div'); feed.className = 'steve-activity-feed';
  const note = document.createElement('p'); note.textContent = 'Read-only request history. Open its project to reply using the project’s STEVE controls.';
  const error = document.createElement('p'); error.setAttribute('role', 'status');
  const navigate = async record => {
    const binding = bindingState.binding;
    if (!record || record.renderUserId !== String(getOwner().userId || '')
      || !bindingOwns(binding, { userId: record.renderUserId, projectId: record.renderProjectId })) return;
    const revision = binding.revision;
    const owner = { userId: record.renderUserId, projectId: record.renderProjectId };
    try { await openProject(owner.projectId, () => owner.userId === String(getOwner().userId || '') && revision === bindingState.binding?.revision);
      if (revision === bindingState.binding?.revision) activity.close(); }
    catch { error.textContent = 'Could not open this project. Please try again.'; }
  };
  panel.append(title, button('Close chat', () => activity.close()), feed, note,
    button('Open project to reply', () => navigate(activity.records.get(activity.selected))), error);
  const connector = projectConnector || new SteveConnector();
  let panelSignature = '', cardSignature = '';
  const activity = new SteveActivity({ bindingState, getUserId: () => getOwner().userId,
    read: read || ((packet, signal) => readSteveActivity(connector, packet, signal)), ingest, onAvailability,
    onChange: state => {
      const record = state.records.get(state.selected);
      panel.hidden = !record;
      const signature = JSON.stringify(record || null);
      if (signature !== panelSignature) {
        panelSignature = signature; error.textContent = '';
        title.textContent = record ? `STEVE · ${projectLabel(record.renderProjectId)}` : '';
        const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
        feed.replaceChildren();
        for (const message of record?.messages || []) {
          if (!message.text || !['user', 'assistant'].includes(message.role)) continue;
          const row = document.createElement('p'); row.dataset.role = message.role;
          const speaker = document.createElement('b'); speaker.textContent = message.role === 'user' ? 'You' : 'STEVE';
          const text = document.createElement('span'); text.textContent = message.text;
          row.append(speaker, text); feed.append(row);
        }
        if (atBottom) feed.scrollTop = feed.scrollHeight;
      }
      const nextCards = JSON.stringify(state.cards);
      if (nextCards === cardSignature) return;
      cardSignature = nextCards; cards.replaceChildren();
      for (const card of state.cards) {
        const snapshot = state.records.get(card.requestId), node = document.createElement('article'); node.className = 'steve-activity-card';
        const mark = document.createElement('img'); mark.className = 'steve-activity-mark'; mark.src = '/cad/steve-mark.svg?v=20261008-steve-activity3'; mark.alt = ''; mark.width = 24; mark.height = 24;
        const label = document.createElement('strong'); label.textContent = `STEVE · ${projectLabel(snapshot.renderProjectId)}`;
        const text = document.createElement('p'); text.textContent = card.text;
        node.append(mark, label, text, button('Open chat', () => {
          window.dispatchEvent(new Event('render3d:steve-activity-open')); activity.select(card.requestId);
        }), button('Open project', () => navigate(snapshot)), button('Dismiss', () => activity.dismiss(card.requestId)));
        cards.append(node);
      }
    },
  });
  const lock = document.createElement('section'); lock.className = 'steve-project-lock';
  lock.setAttribute('aria-label', 'STEVE project lock');
  const badge = document.createElement('strong'); badge.dataset.steveLockBadge = '1';
  const lockStatus = document.createElement('p'); lockStatus.setAttribute('role', 'status');
  const choices = document.createElement('select'); choices.setAttribute('aria-label', 'New STEVE locked project');
  const confirmation = document.createElement('div'); confirmation.hidden = true;
  const confirmationText = document.createElement('p');
  const labelFor = id => projectLabel(id) + ' #' + id;
  const openLocked = button('Open locked project', () => {
    const binding = bindingState.binding;
    if (!binding || binding.renderUserId !== String(getOwner().userId || '')) return;
    const isCurrent = () => binding.revision === bindingState.binding?.revision
      && binding.renderUserId === String(getOwner().userId || '');
    void Promise.resolve(openProject(binding.renderProjectId, isCurrent)).catch(() => {
      lockStatus.textContent = 'Could not open the locked project. Please try again.';
    });
  });
  const change = button('Change project', async () => {
    change.disabled = true; lockStatus.textContent = '';
    try {
      await bindingState.refresh(connector);
      const owner = getOwner();
      bindingState.prepare({ userId: owner.userId, projectId: choices.value || owner.projectId });
    } catch (error) { lockStatus.textContent = error.message; }
    finally { renderLock(); }
  });
  const confirm = button('Confirm project lock', async () => {
    confirm.disabled = true; lockStatus.textContent = '';
    try {
      if (bindingState.pending?.renderUserId !== String(getOwner().userId || '')) throw bindingError('project_binding_changed');
      await bindingState.confirm(connector);
      lockStatus.textContent = 'STEVE project lock saved.';
      void activity.tick().catch(() => {});
    } catch (error) { lockStatus.textContent = error.message; }
    finally { renderLock(); }
  });
  const cancel = button('Cancel', () => { bindingState.cancel(); lockStatus.textContent = ''; });
  confirmation.append(confirmationText, confirm, cancel);
  lock.append(badge, openLocked, choices, change, confirmation, lockStatus); root.prepend(lock);
  function renderLock() {
    const binding = bindingState.binding, pending = bindingState.pending;
    badge.textContent = binding ? 'STEVE locked to ' + labelFor(binding.renderProjectId)
      : bindingState.known ? 'STEVE is not locked to a project' : 'STEVE project lock unavailable · connect or update STEVE';
    openLocked.hidden = !binding;
    openLocked.disabled = !binding || binding.renderUserId !== String(getOwner().userId || '');
    change.textContent = binding ? 'Change project' : 'Lock STEVE to project';
    const projects = getProjects();
    const current = getOwner();
    const candidates = projects.length ? projects : current.projectId ? [{ id: current.projectId, name: projectLabel(current.projectId) }] : [];
    const signature = JSON.stringify(candidates.map(project => [String(project.id), project.name]));
    if (choices.dataset.signature !== signature) {
      const selected = choices.value || current.projectId;
      choices.replaceChildren();
      for (const project of candidates) {
        const option = document.createElement('option'); option.value = String(project.id);
        option.textContent = (project.name || project.id) + ' #' + project.id;
        choices.append(option);
      }
      if (candidates.some(project => String(project.id) === selected)) choices.value = selected;
      choices.dataset.signature = signature;
    }
    const busy = bindingState.busy || bindingState.changing;
    choices.disabled = busy || Boolean(pending);
    change.disabled = busy || Boolean(pending) || !current.userId || !choices.value;
    confirmation.hidden = !pending;
    if (pending) confirmationText.textContent = 'Change STEVE from '
      + (binding ? labelFor(binding.renderProjectId) : 'unbound') + ' to ' + labelFor(pending.renderProjectId)
      + '? Existing history stays read-only in its original project.';
    confirm.disabled = busy; cancel.disabled = bindingState.changing;
    change.title = busy ? 'Wait for STEVE to finish before changing projects.' : '';
  }
  const unsubscribeLock = bindingState.subscribe(renderLock);
  const navigation = () => { bindingState.cancel(); renderLock(); };
  window.addEventListener('render3d:project-changed', navigation);
  renderLock();
  const reset = () => { bindingState.reset(); activity.reset(); renderLock(); void activity.tick().catch(() => {}); };
  const close = () => activity.close();
  const dispose = () => {
    unsubscribeLock(); activity.dispose(); root.remove(); link.remove();
    window.removeEventListener('render3d:project-changed', navigation);
    window.removeEventListener('render3d:auth-session', reset);
    window.removeEventListener('render3d:design-chat-open', close);
    window.removeEventListener('pagehide', dispose);
  };
  window.addEventListener('render3d:auth-session', reset);
  window.addEventListener('render3d:design-chat-open', close);
  window.addEventListener('pagehide', dispose, { once: true });
  activity.start();
  return { activity, dispose };
}
