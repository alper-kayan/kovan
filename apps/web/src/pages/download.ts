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

// The terminal install commands, each copied with one click.
for (const copy of document.querySelectorAll<HTMLButtonElement>('[data-cli-copy]')) {
  const command = copy.parentElement?.querySelector<HTMLElement>('[data-cli-command]');
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(command?.textContent ?? '').then(
      () => {
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1600);
      },
      () => {
        // No clipboard (an insecure page, or denied): select the text so it can be copied by hand.
        if (command) getSelection()?.selectAllChildren(command);
      },
    );
  });
}
