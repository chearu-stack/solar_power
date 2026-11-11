(() => {
  'use strict';

  const menuToggle = document.getElementById('menuToggle');
  const mainNav = document.getElementById('mainNav');
  if (menuToggle && mainNav) {
    menuToggle.addEventListener('click', () => {
      const expanded = menuToggle.getAttribute('aria-expanded') === 'true';
      menuToggle.setAttribute('aria-expanded', String(!expanded));
      menuToggle.setAttribute('aria-label', expanded ? 'Открыть меню' : 'Закрыть меню');
      mainNav.classList.toggle('open', !expanded);
    });
    mainNav.addEventListener('click', event => {
      if (event.target.closest('a')) {
        mainNav.classList.remove('open');
        menuToggle.setAttribute('aria-expanded', 'false');
        menuToggle.setAttribute('aria-label', 'Открыть меню');
      }
    });
  }

  document.querySelectorAll('[data-check]').forEach(input => {
    const key = `solar-check-${input.dataset.check}`;
    try { input.checked = localStorage.getItem(key) === 'true'; } catch {}
    input.addEventListener('change', () => {
      try { localStorage.setItem(key, String(input.checked)); } catch {}
    });
  });

  const cards = [...document.querySelectorAll('.photo-card')];
  const dialog = document.getElementById('lightbox');
  const image = document.getElementById('lightboxImage');
  const caption = document.getElementById('lightboxCaption');
  if (!cards.length || !dialog || !image || !caption) return;

  let activeIndex = 0;
  function showPhoto(index) {
    activeIndex = (index + cards.length) % cards.length;
    const card = cards[activeIndex];
    image.src = card.dataset.full;
    image.alt = card.querySelector('img').alt;
    caption.textContent = `${card.dataset.title} · ${activeIndex + 1} из ${cards.length}`;
  }

  cards.forEach((card, index) => card.addEventListener('click', () => {
    showPhoto(index);
    dialog.showModal();
    document.body.classList.add('dialog-open');
  }));

  function closeDialog() {
    if (dialog.open) dialog.close();
    document.body.classList.remove('dialog-open');
  }
  document.getElementById('closeLightbox')?.addEventListener('click', closeDialog);
  document.getElementById('previousPhoto')?.addEventListener('click', () => showPhoto(activeIndex - 1));
  document.getElementById('nextPhoto')?.addEventListener('click', () => showPhoto(activeIndex + 1));
  dialog.addEventListener('close', () => document.body.classList.remove('dialog-open'));
  dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') showPhoto(activeIndex - 1);
    if (event.key === 'ArrowRight') showPhoto(activeIndex + 1);
  });
})();
