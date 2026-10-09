import { REVIEWED_CORRECTIONS } from "./reviewed-topic-feedback.mjs";
// One primary policy category per PQ. Specific schemes take precedence over broad themes.
export const TOPICS = Object.freeze([
  'Access', 'Urgent appointments', 'Golden Hellos', 'Workforce', 'Finance and funding',
  'Interim reforms 2026', 'Contract and long term reform', 'Children', 'Vulnerable patients', 'Public Health',
  'Dental Schools', 'Other',
]);
const RULES = [
  ['Golden Hellos', /\bgolden hellos?\b|\bnew patient premium\b|\brecruitment (?:incentive|payment|premium)\b/i],
  ['Urgent appointments', /\burgent\b|\bemergency\b|\b700[,.]?000\b|\bout.of.hours\b/i],
  ['Workforce', /\bddrb\b|\breview body on doctors\b|\bpay and progression\b|\bdentists?.{0,25}remuneration\b/i],
  ['Interim reforms 2026', /\binterim (?:reform|contract)\b|\b2026\b.{0,80}\b(?:reform|contract|quality|payment)\b|\b(?:reform|contract|quality|payment)\b.{0,80}\b2026\b|\bdental quality and payment\b|\bphase (?:2|two)\b/i],
  ['Dental Schools', /\bdental schools?\b|\bdentistry (?:degree|student|course|place)\b|\b(?:undergraduate|university|universities|bds|portsmouth)\b/i],
  ['Finance and funding', /\b(?:patient|dental|nhs|prescription|penalty) charges?\b|\b(?:charge|fee) exemptions?\b|\b(?:afford|affordability|cost of living|vat|tax|taxation|income|profit|expenses|pay|salary|salaries|remuneration|ddrb)\b|\bprivate (?:cost|fee|price)\b|\bpenalt(?:y|ies)\b|\b(?:maternity|medical) exemptions?\b|\bfree nhs dental treatment\b/i],
  ['Children', /\b(?:child\w*|paediatric\w*|pediatric\w*|babies|baby|infant\w*|young people|under[ -]18s?|schoolchildren|school children|school pupils|supervised toothbrushing|nurser(?:y|ies))\b/i],
  ['Vulnerable patients', /\b(?:vulnerable|disabilit\w*|disabled|autis\w*|special care|care homes?|homeless\w*|prison\w*|looked.after|safeguarding|learning difficult\w*|domiciliary|community dental|cds)\b/i],
  ['Public Health', /\b(?:fluorid\w*|prevention|preventative|preventive|oral health|tooth decay|caries|sugar|brushing|toothbrush\w*|supervised toothbrushing|gingivitis|periodont\w*|oral cancer|mouth cancer|public health|sepsis|dental infection)\b/i],
  ['Contract and long term reform', /\b(?:single (?:patient|medical) record|digital integration|electronic patient record)\b|\blong.term\b|\b10.year\b|\bten.year\b|\b(?:fundamental|systemic|structural) reform\b|\b(?:abolish|replace)\w*\b.{0,40}\buda\b/i],
  ['Access', /\b(?:number|change|reduction|increase)\b.{0,100}\b(?:practice|nhs dental) contracts?\b/i],
  ['Contract and long term reform', /\b(?:contract|uda|udas|units? of dental activity|capitation|payment model|commissioning model)\b/i],
  ['Workforce', /\b(?:workforce|recruit\w*|retain\w*|retention|training|trainee\w*|overseas|ore|registration|gdc|hygienist\w*|therapist\w*|dental nurses?|staff\w*|vacanc\w*|tie.in|dentist numbers?|shortage)\b/i],
  ['Finance and funding', /\b(?:funding|funded|budget\w*|investment|invest\w*|spending|expenditure|allocation\w*|underspend\w*|clawback|ring.fenc\w*|financial support)\b/i],
  ['Access', /\b(?:access|appointment\w*|waiting\w*|wait\w*|availability|available|accept\w*|register\w*|provision|dental desert\w*|nhs patients?|find\w* a dentist|state of nhs dentistry)\b/i],
];
export function canonicalTopic(topic) {
  return ({ Finance: 'Finance and funding', Funding: 'Finance and funding',
    'Contract reform': 'Contract and long term reform', 'Long term reform': 'Contract and long term reform' })[topic] || topic;
}
export function classifyQuestion(question) {
  const house = question.house || (/^HL/i.test(question.uin || '') ? 'Lords' : 'Commons');
  const key = `${house}:${question.uin || question.id}:${question.dateTabled || ''}`;
  const reviewed = REVIEWED_CORRECTIONS.find(entry => entry.key === key);
  if (reviewed) return reviewed.topic;
  // Answer wording must not move a question between categories when it is answered.
  const text = `${question.heading || ''} ${question.questionText || ''}`;
  return RULES.find(([, rule]) => rule.test(text))?.[0] || 'Other';
}
export function rangeStart(months, now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

