import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOPICS, classifyQuestion, rangeStart } from './topics.mjs';
const cases = [
 ['Access', 'What steps will improve access to NHS dentists in my constituency?'],
 ['Urgent appointments', 'How many urgent NHS dental appointments are available?'],
 ['Golden Hellos', 'What effect have golden hellos had on dental workforce recruitment?'],
 ['Workforce', 'What steps are being taken to retain the dental workforce?'],
 ['Finance and funding', 'What is the budget allocation for NHS dentistry?'],
 ['Interim reforms 2026', 'When will the 2026 dental contract reforms be implemented?'],
 ['Contract and long term reform', 'Will units of dental activity in the dental contract be changed?'],
 ['Vulnerable patients', 'What provision exists for disabled patients in community dental services?'],
 ['Public Health', 'Will water fluoridation reduce tooth decay?'],
 ['Contract and long term reform', 'What long term reform is planned for the dental contract?'],
 ['Dental Schools', 'How many dental school places will be funded?'],
 ['Finance and funding', 'Will dental patient charges be increased?'],
 ['Children', 'How will childhood tooth decay be reduced in primary school pupils?'],
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


// Paraphrased regression examples from reviewed feedback, plus nearby cases.
test('Reviewed policy boundaries generalise to other PQs', () => {
 const examples = [
   ['Finance and funding', 'Review of penalty charge notices and refunded dental fines'],
   ['Public Health', 'Monitoring sepsis arising from dental infection'],
   ['Contract and long term reform', 'Dentist access to the single patient record'],
   ['Workforce', '2026 recommendations for pay and progression in community dental services'],
   ['Access', 'Change in number of NHS dental practice contracts in a constituency'],
   ['Finance and funding', 'Cost of free NHS dental treatment under maternity exemption rules'],
   ['Access', 'An annual account of the state of NHS dentistry'],
   ['Children', 'NHS dentist access for children and teenagers'],
   ['Children', 'Toothbrushing support in nurseries'],
   ['Workforce', 'Dental workforce shortages'],
 ];
 for (const [expected, questionText] of examples) assert.equal(classifyQuestion({questionText}), expected, questionText);
});

test('All 11 reviewed corrections are shared, including merged labels', async () => {
 const { REVIEWED_CORRECTIONS } = await import('./reviewed-topic-feedback.mjs');
 assert.equal(REVIEWED_CORRECTIONS.length, 11);
 for (const entry of REVIEWED_CORRECTIONS) {
   const [house, uin, dateTabled] = entry.key.split(':');
   assert.ok(TOPICS.includes(entry.topic));
   assert.equal(classifyQuestion({house,uin,dateTabled,questionText:'Generic dental question'}), entry.topic);
 }
 assert.equal(TOPICS.length,12);
 assert.equal(new Set(TOPICS).size,12);
});
