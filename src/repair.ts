import config from './generated/workflows.json';
import type { Localized } from './i18n/messages';

export const assessments = ['valid', 'needs_improvement', 'invalid', 'cannot_assess'] as const;
export type Assessment = typeof assessments[number];
export const statuses = ['draft', 'pending', 'in_review', 'peer_reviewed', 'disputed', 'rejected', 'needs_clarification'] as const;

type RubricField = {
  name: string;
  label: Localized;
  options: string[];
  extra_option?: { value: string; when_outcome: string };
};
export type WorkflowType = 'repair_case' | 'diagnosis_review';

type Rubric = {
  workflow_type: string;
  version: number;
  fields: RubricField[];
  options: Record<string, Localized>;
  reasoning: { label: Localized; required_for: string[]; max_length: number };
};
const rubrics = config.rubrics as Rubric[];
export function rubricFor(version?: number, workflow: WorkflowType = 'repair_case') {
  return rubrics.filter(rubric => rubric.workflow_type === workflow && (version === undefined || rubric.version === version))
    .sort((a, b) => b.version - a.version)[0];
}

export function rubricOptions(field: RubricField, outcome?: string) {
  const extra = field.extra_option;
  return extra && extra.when_outcome === outcome ? [...field.options, extra.value] : field.options;
}

export type FeedbackEntry = {
  assessment: Assessment;
  rubric_version: number | null;
  answers: Record<string, string>;
};
export type Repair = {
  id: string;
  schema_version: number;
  status: typeof statuses[number];
  source_type: string | null;
  sharing_permission: string | null;
  content_language: string;
  updated_at: number;
  created_at?: number;
  review_consent?: boolean;
  author_nickname?: string;
  previous_revision_id?: string | null;
  next_revision_id?: string | null;
  dissent?: boolean;
  feedback?: FeedbackEntry[];
  values: Record<string, string>;
};
export type Page<T> = { items: T[]; next_offset: number | null };
export type Assignment = {
  id: string;
  workflow_type: WorkflowType;
  completed: boolean;
  rubric_version: number;
  feedback: FeedbackEntry | null;
  repair: Pick<Repair, 'id' | 'schema_version' | 'content_language' | 'values'>;
};
