import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions', 'shell-governor');

test('Layout_EntryFile_OnlyImportsMain', () => {
    // Arrange
    const dir = EXTENSION_DIR;
    const entryPath = join(dir, 'extension.mjs');

    // Act
    const entryExists = existsSync(entryPath);
    const entrySource = entryExists ? readFileSync(entryPath, 'utf8') : '';
    const cjsOrJsExists = existsSync(join(dir, 'extension.cjs')) || existsSync(join(dir, 'extension.js'));

    // Assert
    assert.equal(entryExists, true, 'extension.mjs must exist so the CLI loads the governor');
    assert.equal(entrySource.trim(), 'import "./main.mjs";', 'extension.mjs must contain only the import of ./main.mjs');
    assert.equal(cjsOrJsExists, false, 'extension.cjs/extension.js must not exist; the CLI would load them as well');
});
