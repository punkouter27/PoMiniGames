import test from 'node:test';
import assert from 'node:assert/strict';
import { syllables, mouthPlan, mouthOpen, wordAt } from '../src/PoMiniGames.Client/wwwroot/js/pofighter/announcer.js';

test('announcer lip sync: one jaw opening per syllable, words in order, closed between', () => {
    assert.equal(syllables('Kim!'), 1);
    assert.equal(syllables('Versus...'), 2);
    assert.equal(syllables('Nick'), 1);
    assert.equal(syllables('Rose'), 1, 'a silent final e is not a syllable');
    assert.equal(syllables('Shadow'), 2);

    const line = 'Kim! Versus... Nick!';
    const { words, duration } = mouthPlan(line);
    assert.deepEqual(words.map(w => w.text), ['Kim!', 'Versus...', 'Nick!']);
    assert.deepEqual(words.map(w => w.plan.length), [1, 2, 1]);
    assert.ok(words[1].at > words[0].at && words[2].at > words[1].at);
    assert.ok(duration > 0.8 && duration < 3, `a short call, not ${duration}s`);

    const syl = words[1].plan[0];
    assert.ok(mouthOpen(words[1].plan, syl.at + syl.len / 2) > 0.95, 'wide open mid-syllable');
    assert.equal(mouthOpen(words[1].plan, syl.at + syl.len + 0.001), 0, 'closed between syllables');
    assert.equal(mouthOpen(words[1].plan, 10), 0, 'closed after the word');

    // Word boundaries from speechSynthesis come as character offsets.
    assert.equal(wordAt(words, line.indexOf('Versus')), 1);
    assert.equal(wordAt(words, line.indexOf('Nick')), 2);
    assert.equal(wordAt(words, 0), 0);
});
