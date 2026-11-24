import config from './generated/workflows.json';
import { localize, type Locale, type Localized } from './i18n/messages';

export type Option = { value: string; label: Localized };
export type Field = {
  name: string;
  label: Localized;
  description?: Localized;
  type: 'text' | 'textarea' | 'select';
  required?: boolean;
  options?: Option[];
  required_if?: { field: string; in: string[] };
};
export type Workflow = {
  type: string;
  version: number;
  title: Localized;
  description: Localized;
  fields: Field[];
  review_questions: Localized[];
  points: { submission: number; review: number };
};

export const categories: Option[] = config.categories;
const categoryIds = new Set(categories.map(option => option.value));
const workflows = config.workflows as Workflow[];

export function workflowFor(type: string, version?: number) {
  return workflows.filter(workflow => workflow.type === type &&
    (version === undefined || workflow.version === version))
    .sort((a, b) => b.version - a.version)[0];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function expertiseValues(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > categories.length ||
      !value.every(item => typeof item === 'string' && categoryIds.has(item)) ||
      new Set(value).size !== value.length) return null;
  return value;
}

export function fieldRequired(field: Field, values: Record<string, unknown>): boolean {
  const rule = field.required_if;
  const source = rule && values[rule.field];
  return field.required === true || Boolean(rule && typeof source === 'string' && rule.in.includes(source.trim()));
}

export function fieldLimit(field: Field) {
  return field.type === 'textarea' ? 4000 : 200;
}

export function validationMessage(locale: Locale, key: keyof typeof config.validation) {
  return localize(locale, config.validation[key]);
}

export function validateFields(workflow: Workflow, input: unknown, locale: Locale = 'en') {
  const errors: Record<string, string> = {};
  if (!isRecord(input) || Object.keys(input).some(key => !workflow.fields.some(field => field.name === key))) {
    return { errors: { form: validationMessage(locale, 'unexpected') } };
  }
  for (const field of workflow.fields) {
    const raw = input[field.name];
    if (raw !== undefined && typeof raw !== 'string') {
      errors[field.name] = validationMessage(locale, 'type');
      continue;
    }
    const value = raw?.trim() ?? '';
    if (!value) {
      if (fieldRequired(field, input)) errors[field.name] = validationMessage(locale, 'required');
    } else if (field.type === 'select' && !field.options?.some(option => option.value === value)) {
      errors[field.name] = validationMessage(locale, 'option');
    } else if (value.length > fieldLimit(field)) {
      errors[field.name] = validationMessage(locale, 'length');
    }
  }
  return { errors };
}
