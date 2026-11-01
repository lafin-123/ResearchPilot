import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectPackages } from '../src/main/lib/python-packages'

test('finds aliased, indented, comma separated and from imports', () => {
  assert.deepEqual(detectPackages('import numpy as np, pandas as pd\n  from sklearn.metrics import accuracy_score\nfrom matplotlib import pyplot\nimport numpy.random\nimport os'), ['matplotlib', 'numpy', 'pandas', 'scikit-learn'])
})
test('comments and multiline documentation do not provision packages', () => {
  assert.deepEqual(detectPackages('# import torch\n"""\nimport tensorflow\n"""\nimport scipy # statistics'), ['scipy'])
})
test('heavy dependencies require a configured interpreter', () => {
  assert.throws(() => detectPackages('import torch'), /Python/)
  assert.deepEqual(detectPackages('from torch import nn\nimport numpy', true), ['numpy'])
})
test('unknown imports are never turned into package install names', () => {
  assert.deepEqual(detectPackages('import mysterious_package\nfrom . import local'), [])
})
