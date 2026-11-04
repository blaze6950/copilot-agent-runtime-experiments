// SQL classifier checks ported from the S4 spike selftest (bench/s4-selftest.mjs, section C). The spike id is kept in each comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySql, classifySqliteDot } from '../../extensions/shell-governor/lib/sql.mjs';

test('classifySql_SelectStatement_IsRead', () => {
    // Arrange
    const sql = 'select 1';

    // Act
    const result = classifySql(sql);

    // Assert
    assert.equal(result.cls, 'read'); // C1
});

test('classifySql_WithCteThenInsert_IsWrite', () => {
    // Arrange
    const sql = 'with x as (select 1) insert into t select * from x';

    // Act
    const result = classifySql(sql);

    // Assert
    assert.equal(result.cls, 'write'); // C2
});

test('classifySql_CreateOrReplaceTemporaryTable_IsUnknown', () => {
    // Arrange
    const sql = 'create or replace temporary table t as select 1';

    // Act
    const result = classifySql(sql);

    // Assert
    assert.equal(result.cls, 'unknown'); // C3 (scratch maps to unknown)
});

test('classifySql_SelectSystemFunctionNotAllowlisted_IsExecute', () => {
    // Arrange
    const sql = 'select system$wait(5)';

    // Act
    const result = classifySql(sql);

    // Assert
    assert.equal(result.cls, 'execute'); // C4
});

test('classifySql_DropInsideStringLiteral_IsRead', () => {
    // Arrange
    const sql = "select 'drop table x'";

    // Act
    const result = classifySql(sql);

    // Assert
    assert.equal(result.cls, 'read'); // C5
});

test('classifySql_BeginEndBlock_IsExecute', () => {
    // Arrange
    const sql = 'begin select 1; end';

    // Act
    const result = classifySql(sql);

    // Assert
    assert.equal(result.cls, 'execute'); // C6
});

test('classifySql_AlterSession_IsSession', () => {
    // Arrange
    const sql = 'alter session set x=1';

    // Act
    const result = classifySql(sql);

    // Assert
    assert.equal(result.cls, 'session'); // C6
});

test('classifySqliteDot_TablesCommand_IsRead', () => {
    // Arrange
    const command = '.tables';

    // Act
    const result = classifySqliteDot(command);

    // Assert
    assert.equal(result.cls, 'read'); // C7
});

test('classifySqliteDot_ShellCommand_IsExecute', () => {
    // Arrange
    const command = '.shell ls';

    // Act
    const result = classifySqliteDot(command);

    // Assert
    assert.equal(result.cls, 'execute'); // C7
});
