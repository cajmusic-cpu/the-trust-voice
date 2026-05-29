/* === FADE-IN ON SCROLL === */
const observer = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.classList.add('visible');
      observer.unobserve(e.target);
    }
  });
}, { threshold: 0.12 });
document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));

/* === SMOOTH SCROLL === */
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const href = a.getAttribute('href');
    const target = href && href.length > 1 && document.querySelector(href);
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth' });
      closeMobileMenu();
    }
  });
});

/* === MOBILE HAMBURGER MENU === */
const hamburger = document.querySelector('.nav-hamburger');
const mobileMenu = document.getElementById('mobileMenu');

function closeMobileMenu() {
  hamburger.classList.remove('open');
  hamburger.setAttribute('aria-expanded', 'false');
  mobileMenu.classList.remove('open');
}

hamburger.addEventListener('click', () => {
  const isOpen = hamburger.classList.contains('open');
  if (isOpen) {
    closeMobileMenu();
  } else {
    hamburger.classList.add('open');
    hamburger.setAttribute('aria-expanded', 'true');
    mobileMenu.classList.add('open');
  }
});

/* === MODALS === */
function openModal(id) {
  const overlay = document.getElementById(id);
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  const firstInput = overlay.querySelector('input, select, textarea, button');
  if (firstInput) firstInput.focus();
}

function closeModal(overlay) {
  overlay.classList.remove('open');
  document.body.style.overflow = '';
}

document.querySelectorAll('.open-consultation-modal').forEach(el => {
  el.addEventListener('click', e => { e.preventDefault(); openModal('consultationModal'); });
});

document.querySelectorAll('.open-advisor-modal').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    const email = el.dataset.contactEmail || 'advisors@thetrustvoice.com';
    const errorLink = document.getElementById('advisorErrorEmail');
    if (errorLink) { errorLink.href = 'mailto:' + email; errorLink.textContent = email; }
    openModal('advisorModal');
  });
});

document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.closest('.modal-overlay')));
});

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay); });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(closeModal);
    closeMobileMenu();
  }
});

/* === NETLIFY FORMS — AJAX SUBMISSION === */
async function handleFormSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const submitBtn = form.querySelector('[type="submit"]');
  const successEl = form.nextElementSibling;
  const errorEl = form.querySelector('.form-error');

  const originalText = submitBtn.textContent;
  submitBtn.textContent = 'Sending…';
  submitBtn.disabled = true;
  if (errorEl) errorEl.classList.remove('visible');

  try {
    const response = await fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData(form)).toString(),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    form.style.display = 'none';
    if (successEl) successEl.classList.add('visible');
  } catch {
    submitBtn.textContent = originalText;
    submitBtn.disabled = false;
    if (errorEl) errorEl.classList.add('visible');
  }
}

document.getElementById('consultationForm').addEventListener('submit', handleFormSubmit);
document.getElementById('advisorForm').addEventListener('submit', handleFormSubmit);
