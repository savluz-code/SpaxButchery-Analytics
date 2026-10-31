'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('function validOutreachDate(');
const end = html.indexOf('window.sendOne=', start);
assert.ok(start !== -1 && end > start);

function setup() {
  const fields = {};
  for (const id of ['segSel','segDateFrom','segDateTo','segDateRange','segDateHint','tplSel','tplText','tplPrev','tplGeneric','segCount','selAll','segTable','bulkStatus','bulkNext']) fields[id] = { value: '', style: {}, textContent: '', innerHTML: '', checked: false };
  fields.segSel.value = 'newWeek';
  const tbody = { innerHTML: '' };
  fields.segTable.querySelector = () => tbody;
  const customers = [
    {name:'Monday',contact:'0712345678',firstVisit:'2026-12-28',spent:100,days:10},
    {name:'Today',contact:'0712345679',firstVisit:'2027-01-03T08:00:00',spent:200,days:0},
    {name:'Previous',contact:'0712345680',firstVisit:'2026-12-27',spent:300,days:70},
    {name:'Future',contact:'0712345681',firstVisit:'2027-01-04',spent:400,days:0},
    {name:'No date',contact:'0712345682',firstVisit:'',spent:20,days:0},
    {name:'Bad date',contact:'0712345683',firstVisit:'2027-02-30',spent:20,days:0},
    {name:'Masked',contact:'071***5678',firstVisit:'2027-01-01',spent:20,days:0},
    {name:'Marked masked',contact:'0712345684',masked:true,firstVisit:'2027-01-01',spent:20,days:0},
    {name:'No phone',contact:'',firstVisit:'2027-01-01',spent:20,days:0}
  ];
  const state = { today:'2027-01-03' }, window = {};
  const context = { $, DB: { customers }, window, getTodayEAT:()=>state.today, stripTime: value => String(value || '').slice(0,10), TEMPLATES:{winback:'Hello'}, fill:(t,c)=>t+' '+c.name, genericMsg:t=>t, kes:n=>'KES '+n, escHtml:String, document:{querySelectorAll:()=>[]}, Date };
  function $(id){return fields[id];}
  vm.runInNewContext(html.slice(start,end), context);
  return { fields, customers, context, window, state, tbody };
}
function names(pool) { return Array.from(pool, c=>c.name); }

test('new this week uses EAT Monday through today across years and excludes unreachable and future customers', () => {
  const { context, fields, window, tbody } = setup();
  context.renderSeg();
  assert.deepEqual(names(window._pool), ['Today','Monday']);
  assert.equal(fields.segCount.textContent, 2);
  assert.match(fields.segDateHint.textContent, /2026-12-28 to 2027-01-03.*Week starts Monday/);
  assert.equal(fields.segDateRange.style.display, 'none');
  assert.match(tbody.innerHTML, /2026-12-28/);
  assert.equal(fields.selAll.checked, true);
});

test('new this month starts on the first and does not include future acquisitions', () => {
  const { fields, context, window, state } = setup();
  fields.segSel.value='newMonth';
  context.renderSeg();
  assert.deepEqual(names(window._pool), ['Today']);
  assert.match(fields.segDateHint.textContent, /2027-01-01 to 2027-01-03/);
  state.today='2027-01-01';
  context.renderSeg();
  assert.deepEqual(names(window._pool), []);
});

test('custom date range is inclusive, requires valid ordered dates, and updates on change', () => {
  const { fields, context, window } = setup();
  fields.segSel.value='newRange';
  context.renderSeg();
  assert.equal(fields.segDateRange.style.display, 'block');
  assert.match(fields.segDateHint.textContent, /Select both/);
  assert.equal(window._pool.length, 0);
  fields.segDateFrom.value='2026-12-27'; fields.segDateTo.value='2026-12-28';
  fields.segDateTo.onchange();
  assert.deepEqual(names(window._pool), ['Previous','Monday']);
  fields.segDateFrom.value='2027-01-04';
  fields.segDateFrom.onchange();
  assert.equal(window._pool.length, 0);
  assert.match(fields.segDateHint.textContent, /on or before/);
  fields.segDateFrom.value='2027-02-30'; fields.segDateTo.value='2027-03-03';
  fields.segDateTo.onchange();
  assert.equal(window._pool.length, 0);
  assert.match(fields.segDateHint.textContent, /valid dates/);
  fields.segSel.value='risk'; fields.segSel.onchange();
  assert.equal(fields.segDateRange.style.display, 'none');
  assert.equal(fields.segDateHint.style.display, 'none');
  assert.deepEqual(names(window._pool), ['Previous']);
});
