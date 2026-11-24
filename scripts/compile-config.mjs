import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { parse } from 'yaml';

const directory = new URL('../config/', import.meta.url);
const read = async name => parse(await readFile(new URL(name, directory), 'utf8'));
const categories = await read('categories.yaml');
const validation = await read('validation.yaml');
const locales = ['en', 'de', 'tr', 'pl', 'ru', 'ar'];

function checkText(text, label) {
  check(text && locales.every(locale => typeof text[locale] === 'string' && text[locale].trim()),
    `Missing translation for ${label}`);
}

for (const key of ['required', 'type', 'option', 'length', 'unexpected']) checkText(validation[key], key);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function checkOptions(options) {
  check(Array.isArray(options) && options.length > 0, 'Expected select options');
  check(options.every(option => /^[a-z][a-z0-9_]*$/.test(option.value)), 'Invalid option');
  for (const option of options) checkText(option.label, option.value);
  check(new Set(options.map(option => option.value)).size === options.length, 'Duplicate option IDs');
}

checkOptions(categories);
const workflows = [];
for (const file of (await readdir(directory)).sort()) {
  const match = /^(repair_case|diagnosis_review)\.v([1-9]\d*)\.yaml$/.exec(file);
  if (!match) continue;
  const workflow = await read(file);
  check(workflow.type === match[1] && workflow.version === Number(match[2]), `Invalid version in ${file}`);
  checkText(workflow.title, file);
  checkText(workflow.description, file);
  for (const question of workflow.review_questions) checkText(question, file);
  const names = new Set();
  for (const field of workflow.fields) {
    check(/^[a-z][a-z0-9_]*$/.test(field.name) && !names.has(field.name), `Invalid field in ${file}`);
    names.add(field.name);
    checkText(field.label, field.name);
    if (field.description !== undefined) checkText(field.description, field.name);
    check(['text', 'textarea', 'select'].includes(field.type), `Unsupported field type in ${file}`);
    if (field.options_from !== undefined) {
      check(field.type === 'select' && field.options_from === 'categories', `Unknown option source in ${file}`);
      field.options = categories;
      delete field.options_from;
    }
    if (field.type === 'select') checkOptions(field.options);
  }
  for (const field of workflow.fields) {
    if (field.required_if === undefined) continue;
    const rule = field.required_if;
    const source = workflow.fields.find(candidate => candidate.name === rule.field);
    check(source?.type === 'select' && source !== field && Array.isArray(rule.in) && rule.in.length &&
      rule.in.every(value => source.options.some(option => option.value === value)), `Invalid required_if in ${file}`);
  }
  workflows.push(workflow);
}
check(['repair_case', 'diagnosis_review'].every(type => workflows.some(workflow => workflow.type === type)),
  'Both workflow types must be configured');
const rubrics = [];
for (const file of (await readdir(directory)).sort()) {
  const match = /^repair_review\.v([1-9]\d*)\.yaml$/.exec(file);
  if (!match) continue;
  const rubric = await read(file);
  check(rubric.version === Number(match[1]), `Invalid rubric version in ${file}`);
  const names = rubric.fields.map(field => field.name);
  check(names.length === 4 && ['technical_plausibility', 'resolution_consistency', 'explanation_sufficient',
    'overall_assessment'].every(name => names.includes(name)), `Invalid rubric fields in ${file}`);
  for (const [key, label] of Object.entries(rubric.options)) checkText(label, key);
  for (const field of rubric.fields) {
    checkText(field.label, field.name);
    check(field.options.length && field.options.every(key => Object.hasOwn(rubric.options, key)), `Invalid rubric options in ${file}`);
    if (field.extra_option) check(Object.hasOwn(rubric.options, field.extra_option.value) &&
      field.extra_option.when_outcome === 'unresolved', `Invalid conditional option in ${file}`);
  }
  const assessments = rubric.fields.find(field => field.name === 'overall_assessment').options;
  check(assessments.length === 4 && ['valid', 'needs_improvement', 'invalid', 'cannot_assess']
    .every(value => assessments.includes(value)), `Invalid assessments in ${file}`);
  checkText(rubric.reasoning.label, 'reasoning');
  check(rubric.reasoning.required_for.every(key => assessments.includes(key)) &&
    Number.isInteger(rubric.reasoning.max_length) && rubric.reasoning.max_length > 0, `Invalid reasoning rule in ${file}`);
  rubrics.push(rubric);
}
check(rubrics.length > 0, 'Configure at least one repair review rubric');
const output = new URL('../src/generated/', import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(new URL('workflows.json', output), JSON.stringify({ categories, workflows, validation, rubrics }, null, 2) + '\n');
