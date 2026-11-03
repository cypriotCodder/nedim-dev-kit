// Motion tokens. Keep in sync with DESIGN.md → Motion.
// Usage with `motion` (React): <motion.div {...enter} /> or transition={t.base}
import type { Transition, Variants } from "motion/react";

export const ease = {
  out: [0.22, 1, 0.36, 1] as const,
  inOut: [0.65, 0, 0.35, 1] as const,
};

export const t = {
  fast: { duration: 0.12, ease: ease.out } satisfies Transition,
  base: { duration: 0.2, ease: ease.out } satisfies Transition,
  slow: { duration: 0.32, ease: ease.inOut } satisfies Transition,
  spring: { type: "spring", stiffness: 400, damping: 30 } satisfies Transition,
};

/** Small, quiet entrance: 6px rise + fade. */
export const enter = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 4 },
  transition: t.base,
};

/** Stagger children (max ~6 visible items). */
export const list: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.03 } },
};
export const listItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: t.base },
};

/** Tactile press for buttons/rows. */
export const press = {
  whileTap: { scale: 0.97 },
  transition: t.fast,
};

/** Bottom sheet (mobile) */
export const sheet = {
  initial: { y: "100%" },
  animate: { y: 0 },
  exit: { y: "100%" },
  transition: t.spring,
};
