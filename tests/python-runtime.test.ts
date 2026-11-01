import { test } from 'node:test'
import assert from 'node:assert/strict'
import { supportedPythonVersion, pythonCommandAvailable } from '../src/main/lib/python-runtime'

test('only actual supported Python version output counts as a runtime', () => {
  assert.equal(supportedPythonVersion('Python 3.12.11\r\n'), true)
  assert.equal(supportedPythonVersion('Python 3.10.0'), true)
  assert.equal(supportedPythonVersion('Python 3.9.18'), false)
  assert.equal(supportedPythonVersion('Python was not found; run without arguments to install from the Microsoft Store'), false)
  assert.equal(supportedPythonVersion('Python 2.7.18'), false)
  assert.equal(pythonCommandAvailable(''), false)
  assert.equal(pythonCommandAvailable('researchpilot-missing-python-binary'), false)
})
