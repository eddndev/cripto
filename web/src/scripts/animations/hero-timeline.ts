import gsap from 'gsap';

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const heroElements = {
  paths: document.querySelectorAll<SVGPathElement>('.hero-deco__path'),
  nodes: document.querySelectorAll<SVGCircleElement>('.hero-deco__node'),
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
  gsap.set(heroElements.nodes, { opacity: 1, scale: 1 });
  heroElements.paths.forEach((path) => {
    path.style.strokeDasharray = 'none';
    path.style.strokeDashoffset = '0';
  });
} else {
  // Prepare stroke-draw values
  heroElements.paths.forEach((path) => {
    const length = path.getTotalLength();
    gsap.set(path, { strokeDasharray: length, strokeDashoffset: length });
  });

  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });

  // 1. SVG stroke draw — fast (0s – 0.8s)
  tl.to(heroElements.paths, {
    strokeDashoffset: 0,
    duration: 0.8,
    stagger: 0.04,
    ease: 'power2.out',
  });

  // 2. SVG nodes pop in (overlap)
  tl.to(
    heroElements.nodes,
    {
      scale: 1,
      opacity: 1,
      duration: 0.3,
      stagger: 0.03,
      ease: 'back.out(2)',
    },
    '-=0.4'
  );

  // 3. Label fade in — starts early at 0.3s
  tl.fromTo(
    heroElements.label,
    { opacity: 0, y: 15 },
    { opacity: 1, y: 0, duration: 0.5 },
    0.3
  );

  // 4. Title lines stagger with clipPath reveal
  tl.fromTo(
    heroElements.titleLines,
    { opacity: 0, y: 30, clipPath: 'inset(0 0 100% 0)' },
    {
      opacity: 1,
      y: 0,
      clipPath: 'inset(0 0 0% 0)',
      duration: 0.5,
      stagger: 0.12,
    },
    '-=0.2'
  );

  // 5. Separator grows from left
  tl.fromTo(
    heroElements.separator,
    { scaleX: 0, transformOrigin: 'left center' },
    { scaleX: 1, duration: 0.5, ease: 'power2.inOut' },
    '-=0.25'
  );

  // 6. Bottom row fade in
  tl.fromTo(
    heroElements.bottom,
    { opacity: 0, y: 20 },
    { opacity: 1, y: 0, duration: 0.45 },
    '-=0.2'
  );
}
