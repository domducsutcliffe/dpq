import {test} from 'node:test';
import assert from 'node:assert/strict';
import {questionKey, questionFeatures, topicDecision, validateCorrections} from './topic-feedback.mjs';
const q = (uin, text) => ({uin,house:'Commons',dateTabled:'2026-10-09',questionText:text});
const sample = q('1','What steps will improve access through mobile dental clinics in remote rural villages?');
const correction = (question, topic) => ({key:questionKey(question),features:questionFeatures(question),topic,updatedAt:'2026-10-09T08:00:00Z'});
test('Manual correction survives an answer or dataset refresh',()=>{
 const feedback=[correction(sample,'Vulnerable patients')];
 assert.equal(topicDecision({...sample,answerText:'Funding',topic:'Funding'},feedback).topic,'Vulnerable patients');
 assert.equal(topicDecision(sample,feedback).source,'manual');
});
test('A single correction cannot reclassify other PQs',()=>{
 assert.equal(topicDecision({...sample,uin:'2'},[correction(sample,'Vulnerable patients')]).source,'rules');
});
test('Two agreeing close examples guide new questions',()=>{
 const other=q('2','Access through mobile dental clinics in remote rural villages');
 const feedback=[correction(sample,'Vulnerable patients'),correction(other,'Vulnerable patients')];
 assert.equal(topicDecision({...sample,uin:'3'},feedback).topic,'Vulnerable patients');
 assert.equal(topicDecision({...sample,uin:'3'},feedback).source,'learned');
 assert.equal(topicDecision(q('4','How much funding is allocated to university dental school places?'),feedback).source,'rules');
});
test('Conflicting close feedback blocks learning',()=>{
 const feedback=[correction(sample,'Vulnerable patients'),correction({...sample,uin:'2'},'Vulnerable patients'),correction({...sample,uin:'3'},'Access')];
 assert.equal(topicDecision({...sample,uin:'4'},feedback).source,'rules');
});
test('Import rejects invalid topics and merges each PQ using the latest correction',()=>{
 const first=correction(sample,'Workforce'),later={...first,topic:'Access',updatedAt:'2026-10-09T08:01:00Z'};
 assert.equal(validateCorrections({version:1,corrections:[later,first]})[0].topic,'Access');
 assert.throws(()=>validateCorrections({version:1,corrections:[{...first,topic:'Bad topic'}]}));
 assert.throws(()=>validateCorrections({version:1,corrections:[{...first,features:['<script>']}]}));
});


test('Legacy feedback migrates both pairs of merged categories', () => {
 for (const [oldTopic,newTopic] of [['Finance','Finance and funding'],['Funding','Finance and funding'],['Contract reform','Contract and long term reform'],['Long term reform','Contract and long term reform']]) {
  const input={...correction(sample,oldTopic),originalTopic:oldTopic};
  const result=validateCorrections({version:1,corrections:[input]})[0];
  assert.equal(result.topic,newTopic);
  assert.equal(result.originalTopic,newTopic);
 }
});
