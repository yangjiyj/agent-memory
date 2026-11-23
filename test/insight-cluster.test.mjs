// 记忆缺口的同义归并算法（纯函数）：特征提取和 Jaccard 阈值。运行：node --test test/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { featuresOf, jaccard } from '../hub/admin-insight.mjs';

const sim = (a, b) => jaccard(new Set(featuresOf(a)), new Set(featuresOf(b)));

describe('同义归并：特征和相似度', () => {
  it('大小写、标点、全角半角、词序都不影响', () => {
    assert.deepEqual(featuresOf('Deploy Checklist'), featuresOf('checklist, DEPLOY'));
    assert.deepEqual(featuresOf('证书 续期'), featuresOf('续期，证书'));
    assert.deepEqual(featuresOf('ＡＰＩ　限流'), featuresOf('api 限流'));
    assert.equal(sim('Deploy Checklist', 'checklist deploy'), 1);
  });

  it('空格切开和连着写的中文视为同类（相邻两字拆分）', () => {
    assert.ok(sim('证书 续期', '证书续期') >= 0.6);
    assert.ok(sim('支付 回调 幂等', '支付回调幂等') >= 0.6);
    assert.ok(sim('购物车 库存', '购物车库存') >= 0.6);
  });

  it('去掉失败、怎么、报错这类虚词：证书续期失败和证书 续期是一类', () => {
    assert.deepEqual(featuresOf('证书续期失败'), featuresOf('证书续期报错'));
    assert.ok(sim('证书 续期', '证书续期失败') >= 0.6);
    assert.ok(sim('证书 续期', '证书续期怎么办') >= 0.6);
    assert.ok(sim('how to deploy', 'deploy') >= 0.6, '英文虚词 how / to 之类不算');
  });

  it('只搜了虚词时照原样，不会得到空集合', () => {
    assert.ok(featuresOf('失败').length > 0);
    assert.ok(featuresOf('error').length > 0);
    assert.deepEqual(featuresOf('  ，。 '), []);
  });

  it('只沾一点边的不归一组（低于 0.6）', () => {
    assert.ok(sim('证书 续期', '证书 过期 告警') < 0.6);
    assert.ok(sim('限流', '限流 阈值 租户') < 0.6);
    assert.ok(sim('部署 检查清单', '部署 回滚') < 0.6);
    assert.equal(sim('备份 恢复', '日报 口径'), 0);
  });

  it('jaccard：空集合是 0，相同是 1', () => {
    assert.equal(jaccard(new Set(), new Set(['a'])), 0);
    assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
    assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
  });
});
