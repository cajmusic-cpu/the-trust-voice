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

/* === INQUIRY MODAL === */
const inquiryModal = document.getElementById('inquiryModal');
const inquiryForm  = document.getElementById('inquiryForm');
const formError    = inquiryModal.querySelector('.form-error');
const formSuccess  = inquiryModal.querySelector('.form-success');

function openInquiry() {
  inquiryModal.classList.add('open');
  document.body.style.overflow = 'hidden';
  const first = inquiryModal.querySelector('input:not([tabindex="-1"])');
  if (first) first.focus();
}

function closeInquiry() {
  inquiryModal.classList.remove('open');
  document.body.style.overflow = '';
}

document.querySelectorAll('[data-inquiry]').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    closeMobileMenu();
    openInquiry();
  });
});

inquiryModal.querySelector('.modal-close').addEventListener('click', closeInquiry);
inquiryModal.addEventListener('click', e => { if (e.target === inquiryModal) closeInquiry(); });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeMobileMenu();
    closeInquiry();
  }
});

inquiryForm.addEventListener('submit', async e => {
  e.preventDefault();
  formError.classList.remove('visible');
  const btn = inquiryForm.querySelector('[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData(inquiryForm)).toString(),
    });
    if (!res.ok) throw new Error();
    inquiryForm.hidden = true;
    formSuccess.classList.add('visible');
  } catch {
    formError.classList.add('visible');
    btn.disabled = false;
    btn.textContent = 'Send Message';
  }
});
