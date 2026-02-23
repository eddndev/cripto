import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (prefersReducedMotion) {
  gsap.set(
    [
      '#practices .section-label',
      '#practices .section-title',
      '.card',
      '.about__left',
      '.about__right',
    ],
    { opacity: 1 }
  );
} else {
  const defaults = { ease: 'power3.out' };

  // ── Practices section ──
  const practicesLabel = document.querySelector('#practices .section-label');
  const practicesTitle = document.querySelector('#practices .section-title');
  const cards = document.querySelectorAll('.card');

  if (practicesLabel) {
    gsap.fromTo(
      practicesLabel,
      { opacity: 0, x: -30 },
      {
        opacity: 1,
        x: 0,
        duration: 0.6,
        ...defaults,
        scrollTrigger: {
          trigger: '#practices',
          start: 'top 80%',
        },
      }
    );
  }

  if (practicesTitle) {
    gsap.fromTo(
      practicesTitle,
      { opacity: 0, y: 30 },
      {
        opacity: 1,
        y: 0,
        duration: 0.6,
        ...defaults,
        scrollTrigger: {
          trigger: '#practices',
          start: 'top 78%',
        },
      }
    );
  }

  if (cards.length) {
    gsap.fromTo(
      cards,
      { opacity: 0, y: 40 },
      {
        opacity: 1,
        y: 0,
        duration: 0.6,
        stagger: 0.12,
        ...defaults,
        scrollTrigger: {
          trigger: '.practices__grid',
          start: 'top 82%',
        },
      }
    );
  }

  // ── About section ──
  const aboutLeft = document.querySelector('.about__left');
  const aboutRight = document.querySelector('.about__right');

  if (aboutLeft) {
    gsap.fromTo(
      aboutLeft,
      { opacity: 0, x: -50 },
      {
        opacity: 1,
        x: 0,
        duration: 0.7,
        ...defaults,
        scrollTrigger: {
          trigger: '#about',
          start: 'top 75%',
        },
      }
    );
  }

  if (aboutRight) {
    gsap.fromTo(
      aboutRight,
      { opacity: 0, x: 50 },
      {
        opacity: 1,
        x: 0,
        duration: 0.7,
        ...defaults,
        scrollTrigger: {
          trigger: '#about',
          start: 'top 75%',
        },
      }
    );
  }

  // Footer: no animations — always visible

  // Refresh ScrollTrigger after fonts are loaded
  document.fonts.ready.then(() => ScrollTrigger.refresh());
}
