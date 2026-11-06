/**
 * Answer key schema for memory lab grading (#147). Each scenario has a JSON answer key
 * with checkpoints at specific days; the grader scores memory against them.
 */

import { z } from "zod";

const statementSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
}).strict();

const probeSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  expected: z.string().min(1),
}).strict();

const checkpointSchema = z.object({
  after_day: z.number().int().min(1),
  must_hold: z.array(statementSchema),
  must_not_hold: z.array(statementSchema),
  probes: z.array(probeSchema),
}).strict();

export const answerKeySchema = z.object({
  scenario: z.string().min(1),
  format: z.literal(1),
  checkpoints: z.array(checkpointSchema),
}).strict();

export type AnswerKey = z.infer<typeof answerKeySchema>;
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type Statement = z.infer<typeof statementSchema>;
export type Probe = z.infer<typeof probeSchema>;
