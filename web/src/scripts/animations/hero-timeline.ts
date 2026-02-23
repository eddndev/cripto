import gsap from 'gsap';

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const heroElements = {
  label: document.querySelector('.hero__label'),
  titleLines: document.querySelectorAll('.hero__title-line'),
  separator: document.querySelector('.hero__separator'),
  bottom: document.querySelector('.hero__bottom'),
};

if (prefersReducedMotion) {
  gsap.set(
    [
      heroElements.label,
      heroElements.titleLines,
      heroElements.separator,
      heroElements.bottom,
    ],
    { opacity: 1, y: 0, clearProps: 'clipPath' }
  );
  gsap.set(heroElements.separator, { scaleX: 1 });
} else {
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });

  // Label — immediate
  tl.fromTo(
    heroElements.label,
    { opacity: 0, y: 10 },
    { opacity: 1, y: 0, duration: 0.4 },
    0
  );

  // Title lines — start at 0.1s
  tl.fromTo(
    heroElements.titleLines,
    { opacity: 0, y: 25, clipPath: 'inset(0 0 100% 0)' },
    {
      opacity: 1,
      y: 0,
      clipPath: 'inset(0 0 0% 0)',
      duration: 0.45,
      stagger: 0.1,
    },
    0.1
  );

  // Separator
  tl.fromTo(
    heroElements.separator,
    { scaleX: 0, transformOrigin: 'left center' },
    { scaleX: 1, duration: 0.4, ease: 'power2.inOut' },
    0.35
  );

  // Bottom row
  tl.fromTo(
    heroElements.bottom,
    { opacity: 0, y: 15 },
    { opacity: 1, y: 0, duration: 0.4 },
    0.45
  );
}
