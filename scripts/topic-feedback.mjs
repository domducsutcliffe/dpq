import { TOPICS, classifyQuestion, canonicalTopic } from './topics.mjs?v=category-schema-2';

// Stable across dataset refreshes and independent of row order.
export function questionKey(q) {
  const house = q.house || (/^HL/i.test(q.uin || '') ? 'Lords' : 'Commons');
  return `${house}:${q.uin || q.id}:${q.dateTabled || ''}`;
}
const STOP = new Set('to ask the secretary of state for health and social care what whether how many number steps taking taken plans plan government department make made will would can could should has have had is are was were be been being in on at by as it its this that these those with from into their there they a an all any each such who which when where why about regarding assessment estimate estimates England English UK United Kingdom constituency constituencies dental dentistry dentist dentists services service NHS'.toLowerCase().split(' '));
export function questionFeatures(q) {
  return [...new Set(`${q.heading || ''} ${q.questionText || ''}`.toLowerCase().match(/[a-z][a-z-]{2,}/g) || [])]
    .filter(word => !STOP.has(word))
    .map(word => word.length > 5 && word.endsWith('s') ? word.slice(0, -1) : word)
    .filter((word, i, words) => words.indexOf(word) === i).sort().slice(0, 200);
}
export function validateCorrections(payload) {
  if (payload?.version !== 1 || !Array.isArray(payload.corrections) || payload.corrections.length > 10000) throw new Error('Invalid topic feedback file.');
  const map = new Map();
  for (const entry of payload.corrections) {
    if (!entry || typeof entry.key !== 'string' || !/^(Commons|Lords):[^:]{1,80}:\d{4}-\d{2}-\d{2}$/.test(entry.key) || !TOPICS.includes(canonicalTopic(entry.topic)) || !Array.isArray(entry.features) || entry.features.length > 200 || !entry.features.every(f => typeof f === 'string' && /^[a-z][a-z-]{1,80}$/.test(f)) || typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt))) throw new Error('Invalid topic feedback entry.');
    const clean = {key:entry.key, topic:canonicalTopic(entry.topic), features:[...new Set(entry.features)], updatedAt:entry.updatedAt};
    if (TOPICS.includes(canonicalTopic(entry.originalTopic))) clean.originalTopic = canonicalTopic(entry.originalTopic);
    const existing = map.get(clean.key);
    if (!existing || clean.updatedAt > existing.updatedAt) map.set(clean.key, clean);
  }
  return [...map.values()];
}
export function topicDecision(q, corrections = []) {
  const originalTopic = classifyQuestion(q);
  const exact = corrections.find(entry => entry.key === questionKey(q));
  if (exact) return {topic:exact.topic, source:'manual', originalTopic};
  const features = new Set(questionFeatures(q));
  if (features.size < 4) return {topic:originalTopic, source:'rules', originalTopic};
  const matches = corrections.map(entry => {
    const shared = entry.features.filter(f => features.has(f)).length;
    const union = new Set([...features, ...entry.features]).size;
    return {topic:canonicalTopic(entry.topic), shared, score:union ? shared / union : 0};
  }).filter(match => match.shared >= 4 && match.score >= .5).sort((a,b) => b.score-a.score);
  const best = matches[0];
  // Two independently corrected PQs must agree. Conflicting close examples block learning.
  if (best?.score >= .65 && matches.filter(m => m.topic === best.topic).length >= 2 && !matches.some(m => m.topic !== best.topic && m.score >= best.score-.15)) return {topic:best.topic, source:'learned', originalTopic};
  return {topic:originalTopic, source:'rules', originalTopic};
}

