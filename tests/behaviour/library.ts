// The Scenario library: the 26 candidates of spec §3, in table order.
import type { Scenario } from './scenario.ts';
import { S7, S15, W6, W6b } from './scenarios/exploration.ts';
import { W1, W2, W3, W4, W7 } from './scenarios/pace.ts';
import { F11, W5 } from './scenarios/safety.ts';
import { S5, S6 } from './scenarios/sessions.ts';
import { S0, S0b, S10, S11, S12 } from './scenarios/start.ts';
import { S1, S2, S3, S4, S8, S9, S13, S14 } from './scenarios/verdicts.ts';

export const library: Scenario[] = [S0, S0b, S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11, S12, S13, S14, S15,
  W1, W2, W3, W4, W5, W6, W6b, W7, F11];

/** IDs the spec lists; the library must hold exactly these. P1 was a diagnostic probe and is out. */
export const candidateIds = ['S0', 'S0b', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13',
  'S14', 'S15', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W6b', 'W7', 'F11'];
