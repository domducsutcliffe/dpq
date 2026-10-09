import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOPICS, classifyQuestion, rangeStart } from './topics.mjs';
const cases = [
 ['Access', 'What steps will improve access to NHS dentists in my constituency?'],
 ['Urgent appointments', 'How many urgent NHS dental appointments are available?'],
 ['Golden Hellos', 'What effect have golden hellos had on dental workforce recruitment?'],
 ['Workforce', 'What steps are being taken to retain the dental workforce?'],
 ['Funding', 'What is the budget allocation for NHS dentistry?'],
 ['Interim reforms 2026', 'When will the 2026 dental contract reforms be implemented?'],
 ['Contract reform', 'Will units of dental activity in the dental contract be changed?'],
 ['Vulnerable patients', 'What provision exists for disabled patients in community dental services?'],
 ['Public Health', 'Will water fluoridation reduce tooth decay?'],
 ['Long term reform', 'What long term reform is planned for the dental contract?'],
 ['Dental Schools', 'How many dental school places will be funded?'],
 ['Finance', 'Will dental patient charges be increased?'],
 ['Other', 'What guidance governs the disposal of dental amalgam?'],
];
for (const [expected, questionText] of cases) test(expected, () => assert.equal(classifyQuestion({questionText}), expected));
test('All questions receive exactly one permitted category independent of the answer', () => {
 for (const [, questionText] of cases) {
  const q = {questionText};
  assert.ok(TOPICS.includes(classifyQuestion(q)));
  assert.equal(classifyQuestion({...q, answerText:'Urgent appointments and golden hellos funding'}), classifyQuestion(q));
 }
 assert.equal(classifyQuestion({}), 'Other');
});
test('Calendar month ranges clamp leap-year and short-month boundaries', () => {
 assert.equal(rangeStart(1, new Date('2024-03-31T12:00:00Z')), '2024-02-29');
 assert.equal(rangeStart(3, new Date('2026-10-09T07:00:00Z')), '2026-07-09');
 assert.equal(rangeStart(12, new Date('2026-10-09T07:00:00Z')), '2025-10-09');
});
