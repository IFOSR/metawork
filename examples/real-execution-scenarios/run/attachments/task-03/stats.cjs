#!/usr/bin/env node
// stats.cjs -- 读一个日志文件并打印统计。历史原因写得比较乱，只求行为正确。
const fs = require('fs');

var data = fs.readFileSync(process.argv[2], 'utf8');
var lines = data.split('\n');
var cnt = 0;
var nonempty = 0;
var longest = '';
var longestNo = -1;
var words = {};
for (var i = 0; i < lines.length; i++) {
  cnt++;
  var l = lines[i];
  if (l.trim() != '') {
    nonempty++;
    if (l.length > longest.length) { longest = l; longestNo = i + 1; }
    var ws = l.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    for (var j = 0; j < ws.length; j++) {
      var w = ws[j];
      if (w == '') continue;
      if (words[w] == undefined) words[w] = 0;
      words[w] = words[w] + 1;
    }
  }
}
var entries = [];
for (var k in words) entries.push([k, words[k]]);
entries.sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); });
console.log('lines: ' + cnt);
console.log('nonempty_lines: ' + nonempty);
console.log('longest_line: #' + longestNo + ' (' + longest.length + ' chars)');
console.log('top_words:');
for (var t = 0; t < 3 && t < entries.length; t++) {
  console.log('  ' + entries[t][0] + ': ' + entries[t][1]);
}
