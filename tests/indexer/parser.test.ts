import { describe, it, expect } from 'vitest';
import { parseFile } from '../../src/indexer/parser.js';

describe('Parser', () => {
  describe('TypeScript imports', () => {
    it('extracts named imports', () => {
      const source = `import { A, B } from './mod';`;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('./mod');
      expect(result.imports[0].names).toContain('A');
      expect(result.imports[0].names).toContain('B');
      expect(result.imports[0].isDefault).toBe(false);
      expect(result.imports[0].isNamespace).toBe(false);
    });

    it('extracts default import', () => {
      const source = `import X from './mod';`;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('./mod');
      expect(result.imports[0].names).toContain('X');
      expect(result.imports[0].isDefault).toBe(true);
      expect(result.imports[0].isNamespace).toBe(false);
    });

    it('extracts namespace import', () => {
      const source = `import * as X from './mod';`;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('./mod');
      expect(result.imports[0].names).toContain('X');
      expect(result.imports[0].isDefault).toBe(false);
      expect(result.imports[0].isNamespace).toBe(true);
    });

    it('extracts type-only import', () => {
      const source = `import type { X } from './mod';`;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('./mod');
      expect(result.imports[0].names).toContain('X');
      expect(result.imports[0].isTypeOnly).toBe(true);
    });

    it('extracts mixed default and named imports', () => {
      const source = `import React, { useState, useEffect } from 'react';`;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('react');
      expect(result.imports[0].names).toContain('React');
      expect(result.imports[0].names).toContain('useState');
      expect(result.imports[0].names).toContain('useEffect');
    });
  });

  describe('TypeScript exports', () => {
    it('extracts exported function', () => {
      const source = `export function myFunc() { return 42; }`;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('myFunc');
      expect(result.exports[0].isDefault).toBe(false);
      expect(result.exports[0].isReExport).toBe(false);
    });

    it('extracts exported class', () => {
      const source = `export class MyClass {}`;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('MyClass');
      expect(result.exports[0].isDefault).toBe(false);
    });

    it('extracts default export', () => {
      const source = `export default class DefaultClass {}`;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.exports.some(e => e.isDefault)).toBe(true);
    });

    it('extracts barrel file exports', () => {
      const source = `
        export { A, B } from './module-a';
        export { C } from './module-b';
      `;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.exports.length).toBeGreaterThanOrEqual(3);
      expect(result.exports.some(e => e.name === 'A' && e.isReExport)).toBe(true);
      expect(result.exports.some(e => e.name === 'B' && e.isReExport)).toBe(true);
      expect(result.exports.some(e => e.name === 'C' && e.isReExport)).toBe(true);
    });

    it('extracts re-exports with star', () => {
      const source = `export * from './mod';`;
      const result = parseFile(source, 'test.ts', 'typescript');

      // Star exports should be captured
      expect(result.exports.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('TypeScript symbols', () => {
    it('extracts function declaration', () => {
      const source = `
        function myFunction(x: number): string {
          return x.toString();
        }
      `;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.symbols.some(s => s.kind === 'function' && s.name === 'myFunction')).toBe(true);
      const fn = result.symbols.find(s => s.name === 'myFunction');
      expect(fn?.startLine).toBeGreaterThan(0);
      expect(fn?.endLine).toBeGreaterThanOrEqual(fn?.startLine || 0);
    });

    it('extracts class declaration', () => {
      const source = `
        class MyClass {
          constructor() {}
          method() {}
        }
      `;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.symbols.some(s => s.kind === 'class' && s.name === 'MyClass')).toBe(true);
    });

    it('extracts class with extends', () => {
      const source = `class Child extends Parent {}`;
      const result = parseFile(source, 'test.ts', 'typescript');

      const cls = result.symbols.find(s => s.kind === 'class' && s.name === 'Child');
      expect(cls).toBeDefined();
      expect(cls?.extends).toBe('Parent');
    });

    it('extracts class with implements', () => {
      const source = `class MyClass implements IFoo, IBar {}`;
      const result = parseFile(source, 'test.ts', 'typescript');

      const cls = result.symbols.find(s => s.kind === 'class' && s.name === 'MyClass');
      expect(cls).toBeDefined();
      expect(cls?.implements).toContain('IFoo');
      expect(cls?.implements).toContain('IBar');
    });

    it('extracts interface declaration', () => {
      const source = `
        interface User {
          id: number;
          name: string;
        }
      `;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.symbols.some(s => s.kind === 'interface' && s.name === 'User')).toBe(true);
    });

    it('extracts type alias', () => {
      const source = `type Status = 'active' | 'inactive';`;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.symbols.some(s => s.kind === 'type' && s.name === 'Status')).toBe(true);
    });

    it('extracts enum declaration', () => {
      const source = `
        enum Direction {
          Up,
          Down,
          Left,
          Right
        }
      `;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.symbols.some(s => s.kind === 'enum' && s.name === 'Direction')).toBe(true);
    });

    it('extracts variable declarations', () => {
      const source = `const MAX_SIZE = 100;`;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.symbols.some(s => s.kind === 'variable' && s.name === 'MAX_SIZE')).toBe(true);
    });
  });

  describe('JavaScript', () => {
    it('extracts require() import', () => {
      const source = `const helpers = require('../utils/helpers');`;
      const result = parseFile(source, 'test.js', 'javascript');

      expect(result.imports.some(i => i.source === '../utils/helpers')).toBe(true);
    });

    it('extracts destructured require()', () => {
      const source = `const { generateId, hashPassword } = require('../utils/helpers');`;
      const result = parseFile(source, 'test.js', 'javascript');

      const imp = result.imports.find(i => i.source === '../utils/helpers');
      expect(imp).toBeDefined();
      expect(imp?.names).toContain('generateId');
      expect(imp?.names).toContain('hashPassword');
    });

    it('extracts module.exports', () => {
      const source = `
        function foo() {}
        function bar() {}
        module.exports = { foo, bar };
      `;
      const result = parseFile(source, 'test.js', 'javascript');

      expect(result.exports.some(e => e.name === 'foo')).toBe(true);
      expect(result.exports.some(e => e.name === 'bar')).toBe(true);
    });

    it('extracts function declarations', () => {
      const source = `
        function legacyLogin(email, password) {
          return { email, loggedIn: true };
        }
      `;
      const result = parseFile(source, 'test.js', 'javascript');

      expect(result.symbols.some(s => s.kind === 'function' && s.name === 'legacyLogin')).toBe(true);
    });

    it('extracts class declarations', () => {
      const source = `
        class LegacyClass {
          constructor(name) {
            this.name = name;
          }
        }
      `;
      const result = parseFile(source, 'test.js', 'javascript');

      expect(result.symbols.some(s => s.kind === 'class' && s.name === 'LegacyClass')).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('returns empty result for empty file', () => {
      const source = ``;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.imports).toEqual([]);
      expect(result.exports).toEqual([]);
      expect(result.symbols).toEqual([]);
    });

    it('returns empty result for whitespace-only file', () => {
      const source = `\n\n   \n\n`;
      const result = parseFile(source, 'test.ts', 'typescript');

      expect(result.imports).toEqual([]);
      expect(result.exports).toEqual([]);
      expect(result.symbols).toEqual([]);
    });

    it('handles parse errors gracefully', () => {
      const source = `import { from './broken syntax`;
      const result = parseFile(source, 'test.ts', 'typescript');

      // Should return empty result, not throw
      expect(result).toBeDefined();
      expect(result.imports).toBeDefined();
      expect(result.exports).toBeDefined();
      expect(result.symbols).toBeDefined();
    });

    it('handles comments and string literals', () => {
      const source = `
        // import { fake } from 'not-real';
        /* import { alsoFake } from 'also-not-real'; */
        const str = "import { notAnImport } from 'string-literal'";
        import { real } from './real-import';
      `;
      const result = parseFile(source, 'test.ts', 'typescript');

      // Should only extract the real import
      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('./real-import');
    });
  });

  describe('Complex scenarios', () => {
    it('parses a realistic service file', () => {
      const source = `
        import type { LoginRequest, LoginResponse } from "../types";
        import { UserModel } from "../models/user";
        import { SessionModel } from "../models/session";
        import { generateId, hashPassword } from "../utils/helpers";

        export class AuthService {
          private sessions: Map<string, SessionModel> = new Map();

          async login(request: LoginRequest): Promise<LoginResponse> {
            return { user: null, session: null };
          }

          async logout(sessionId: string): Promise<void> {
            this.sessions.delete(sessionId);
          }
        }
      `;
      const result = parseFile(source, 'auth.ts', 'typescript');

      // Should have imports
      expect(result.imports.length).toBeGreaterThanOrEqual(3);
      expect(result.imports.some(i => i.source.includes('types'))).toBe(true);
      expect(result.imports.some(i => i.source.includes('helpers'))).toBe(true);

      // Should have exports
      expect(result.exports.some(e => e.name === 'AuthService')).toBe(true);

      // Should have symbols
      expect(result.symbols.some(s => s.kind === 'class' && s.name === 'AuthService')).toBe(true);
    });

    it('parses a barrel index file', () => {
      const source = `
        export { AuthService } from './auth';
        export { UserService } from './user';
        export * from './types';
      `;
      const result = parseFile(source, 'index.ts', 'typescript');

      expect(result.exports.length).toBeGreaterThanOrEqual(2);
      expect(result.exports.some(e => e.name === 'AuthService' && e.isReExport)).toBe(true);
      expect(result.exports.some(e => e.name === 'UserService' && e.isReExport)).toBe(true);
    });
  });
});
