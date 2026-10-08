import { SteveActivity, readSteveActivity } from './steve-activity.js?v=20261008-steve-activity3';
import { SteveConnector } from './steve-connector.js?v=20261008-steve-auth-ping1';

export function mountSteveActivity({ host, getOwner, ingest, onAvailability, openProject, projectLabel = id => id, read }) {
  if (!host) return null;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = '/cad/steve-activity.css?v=20261008-steve-activity3'; document.head.append(link);
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
    if (!record || record.renderUserId !== String(getOwner().userId || '')) return;
    const owner = { userId: record.renderUserId, projectId: record.renderProjectId };
    try { await openProject(owner.projectId, () => owner.userId === String(getOwner().userId || '')); activity.close(); }
    catch { error.textContent = 'Could not open this project. Please try again.'; }
  };
  panel.append(title, button('Close chat', () => activity.close()), feed, note,
    button('Open project to reply', () => navigate(activity.records.get(activity.selected))), error);
  const connector = new SteveConnector();
  let panelSignature = '', cardSignature = '';
  const activity = new SteveActivity({ getUserId: () => getOwner().userId,
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
  const reset = () => { activity.reset(); void activity.tick().catch(() => {}); };
  const close = () => activity.close();
  const dispose = () => {
    activity.dispose(); root.remove(); link.remove();
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
