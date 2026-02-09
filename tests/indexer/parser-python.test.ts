import { describe, it, expect } from 'vitest';
import { parseFile } from '../../src/indexer/parser.js';

describe('Python Parser', () => {
  describe('Import extraction', () => {
    it('extracts simple import', () => {
      const source = `import os`;
      const result = parseFile(source, 'test.py', 'python');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('os');
      expect(result.imports[0].names).toContain('os');
      expect(result.imports[0].isDefault).toBe(true);
      expect(result.imports[0].isNamespace).toBe(false);
    });

    it('extracts dotted import', () => {
      const source = `import os.path`;
      const result = parseFile(source, 'test.py', 'python');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('os.path');
      expect(result.imports[0].names).toContain('path');
      expect(result.imports[0].isDefault).toBe(true);
    });

    it('extracts import with alias', () => {
      const source = `import numpy as np`;
      const result = parseFile(source, 'test.py', 'python');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('numpy');
      expect(result.imports[0].names).toContain('np');
      expect(result.imports[0].isDefault).toBe(true);
    });

    it('extracts from import with multiple names', () => {
      const source = `from os import path, environ`;
      const result = parseFile(source, 'test.py', 'python');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('os');
      expect(result.imports[0].names).toContain('path');
      expect(result.imports[0].names).toContain('environ');
      expect(result.imports[0].isDefault).toBe(false);
      expect(result.imports[0].isNamespace).toBe(false);
    });

    it('extracts relative imports', () => {
      const source = `from .models import User`;
      const result = parseFile(source, 'test.py', 'python');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('.models');
      expect(result.imports[0].names).toContain('User');
      expect(result.imports[0].isDefault).toBe(false);
    });

    it('extracts wildcard imports', () => {
      const source = `from utils import *`;
      const result = parseFile(source, 'test.py', 'python');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('utils');
      expect(result.imports[0].names).toHaveLength(0);
      expect(result.imports[0].isNamespace).toBe(true);
    });
  });

  describe('Class extraction', () => {
    it('extracts simple class', () => {
      const source = `class UserService:
    pass`;
      const result = parseFile(source, 'test.py', 'python');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('class');
      expect(result.symbols[0].name).toBe('UserService');
      expect(result.symbols[0].extends).toBeNull();
    });

    it('extracts class with inheritance', () => {
      const source = `class AdminService(UserService):
    pass`;
      const result = parseFile(source, 'test.py', 'python');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('class');
      expect(result.symbols[0].name).toBe('AdminService');
      expect(result.symbols[0].extends).toBe('UserService');
    });

    it('extracts class with multiple base classes', () => {
      const source = `class MyClass(BaseClass, Mixin):
    pass`;
      const result = parseFile(source, 'test.py', 'python');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('class');
      expect(result.symbols[0].name).toBe('MyClass');
      expect(result.symbols[0].extends).toBe('BaseClass');
      expect(result.symbols[0].implements).toContain('Mixin');
    });

    it('extracts class with methods', () => {
      const source = `class UserService:
    def get_user(self, id):
        pass

    def create_user(self, name):
        pass`;
      const result = parseFile(source, 'test.py', 'python');

      expect(result.symbols).toHaveLength(3);
      expect(result.symbols[0].kind).toBe('class');
      expect(result.symbols[0].name).toBe('UserService');
      expect(result.symbols[1].kind).toBe('method');
      expect(result.symbols[1].name).toBe('UserService.get_user');
      expect(result.symbols[2].kind).toBe('method');
      expect(result.symbols[2].name).toBe('UserService.create_user');
    });
  });

  describe('Function extraction', () => {
    it('extracts standalone function', () => {
      const source = `def calculate_total(items):
    return sum(items)`;
      const result = parseFile(source, 'test.py', 'python');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('function');
      expect(result.symbols[0].name).toBe('calculate_total');
      expect(result.symbols[0].signature).toContain('calculate_total');
    });

    it('extracts multiple functions', () => {
      const source = `def foo():
    pass

def bar():
    pass`;
      const result = parseFile(source, 'test.py', 'python');

      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0].kind).toBe('function');
      expect(result.symbols[0].name).toBe('foo');
      expect(result.symbols[1].kind).toBe('function');
      expect(result.symbols[1].name).toBe('bar');
    });
  });

  describe('Export extraction', () => {
    it('exports all public top-level symbols by default', () => {
      const source = `class User:
    pass

def get_user():
    pass

def _private():
    pass`;
      const result = parseFile(source, 'test.py', 'python');

      expect(result.exports).toHaveLength(2);
      expect(result.exports.map(e => e.name)).toContain('User');
      expect(result.exports.map(e => e.name)).toContain('get_user');
      expect(result.exports.map(e => e.name)).not.toContain('_private');
    });

    it('respects __all__ declaration', () => {
      const source = `__all__ = ["User", "get_user"]

class User:
    pass

class Admin:
    pass

def get_user():
    pass

def get_admin():
    pass`;
      const result = parseFile(source, 'test.py', 'python');

      expect(result.exports).toHaveLength(2);
      expect(result.exports.map(e => e.name)).toContain('User');
      expect(result.exports.map(e => e.name)).toContain('get_user');
      expect(result.exports.map(e => e.name)).not.toContain('Admin');
      expect(result.exports.map(e => e.name)).not.toContain('get_admin');
    });
  });
});
