import '../site';
import '../styles/pages.css';
import { h } from '../lib/dom';
import { detectPlatform } from '../lib/platform';

// Put the visitor's own platform first and mark it; everything stays one click away.
void detectPlatform().then((platform) => {
  if (!platform) {
    const note = document.querySelector<HTMLElement>('[data-platform-note]');
    if (note) note.hidden = false;
    return;
  }
  const card = document.querySelector<HTMLElement>(`[data-platform="${platform}"]`);
  if (!card) return;
  card.classList.add('is-yours');
  card.append(h('span', { class: 'platform-tag' }, 'For this device'));
  card.parentElement?.prepend(card);
});
