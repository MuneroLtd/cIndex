import { describe, it, expect } from 'vitest';
import { parseFile } from '../../src/indexer/parser.js';

describe('Rust Parser', () => {
  describe('Use/Import extraction', () => {
    it('extracts simple use statement', () => {
      const source = `use std::collections::HashMap;`;
      const result = parseFile(source, 'test.rs', 'rust');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('std::collections');
      expect(result.imports[0].names).toContain('HashMap');
      expect(result.imports[0].isNamespace).toBe(false);
    });

    it('extracts use statement with braces', () => {
      const source = `use std::io::{Read, Write};`;
      const result = parseFile(source, 'test.rs', 'rust');

      expect(result.imports).toHaveLength(2);
      expect(result.imports[0].source).toBe('std::io');
      expect(result.imports[0].names).toContain('Read');
      expect(result.imports[1].source).toBe('std::io');
      expect(result.imports[1].names).toContain('Write');
    });

    it('extracts wildcard use statement', () => {
      const source = `use std::io::*;`;
      const result = parseFile(source, 'test.rs', 'rust');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('std::io');
      expect(result.imports[0].names).toHaveLength(0);
      expect(result.imports[0].isNamespace).toBe(true);
    });

    it('extracts use statement with alias', () => {
      const source = `use std::io::Read as IoRead;`;
      const result = parseFile(source, 'test.rs', 'rust');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('std::io');
      expect(result.imports[0].names).toContain('Read');
    });
  });

  describe('Struct extraction', () => {
    it('extracts public struct', () => {
      const source = `pub struct User { name: String }`;
      const result = parseFile(source, 'test.rs', 'rust');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('struct');
      expect(result.symbols[0].name).toBe('User');
      expect(result.symbols[0].signature).toContain('pub struct User');

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('User');
    });

    it('extracts private struct without export', () => {
      const source = `struct User { name: String }`;
      const result = parseFile(source, 'test.rs', 'rust');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('struct');
      expect(result.symbols[0].name).toBe('User');

      expect(result.exports).toHaveLength(0);
    });
  });

  describe('Trait extraction', () => {
    it('extracts public trait', () => {
      const source = `pub trait Repository { fn save(&self); }`;
      const result = parseFile(source, 'test.rs', 'rust');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('trait');
      expect(result.symbols[0].name).toBe('Repository');
      expect(result.symbols[0].signature).toContain('pub trait Repository');

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('Repository');
    });
  });

  describe('Impl block methods', () => {
    it('extracts methods from impl block', () => {
      const source = `
impl MyStruct {
    pub fn new() -> Self {
        Self {}
    }

    fn private_method(&self) {}
}`;
      const result = parseFile(source, 'test.rs', 'rust');

      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0].kind).toBe('method');
      expect(result.symbols[0].name).toBe('MyStruct.new');
      expect(result.symbols[0].signature).toContain('pub fn new()');

      expect(result.symbols[1].kind).toBe('method');
      expect(result.symbols[1].name).toBe('MyStruct.private_method');

      // Only public method is exported
      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('MyStruct.new');
    });
  });

  describe('Trait impl methods', () => {
    it('extracts methods from trait implementation', () => {
      const source = `
impl Display for User {
    fn fmt(&self, f: &mut Formatter) -> Result {
        write!(f, "{}", self.name)
    }
}`;
      const result = parseFile(source, 'test.rs', 'rust');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('method');
      expect(result.symbols[0].name).toBe('User.fmt');
      expect(result.symbols[0].implements).toContain('Display');
    });

    it('tracks trait implementations on struct', () => {
      const source = `
pub struct User { name: String }

impl Clone for User {
    fn clone(&self) -> Self {
        Self { name: self.name.clone() }
    }
}`;
      const result = parseFile(source, 'test.rs', 'rust');

      const structSymbol = result.symbols.find(s => s.kind === 'struct');
      expect(structSymbol).toBeDefined();
      expect(structSymbol?.implements).toContain('Clone');
    });
  });

  describe('Function extraction', () => {
    it('extracts public function', () => {
      const source = `pub fn create() -> User { User { name: String::new() } }`;
      const result = parseFile(source, 'test.rs', 'rust');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('function');
      expect(result.symbols[0].name).toBe('create');
      expect(result.symbols[0].signature).toContain('pub fn create()');

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('create');
    });

    it('does not extract impl methods as functions', () => {
      const source = `
impl MyStruct {
    fn helper() {}
}

pub fn standalone_function() {}
`;
      const result = parseFile(source, 'test.rs', 'rust');

      const functions = result.symbols.filter(s => s.kind === 'function');
      expect(functions).toHaveLength(1);
      expect(functions[0].name).toBe('standalone_function');

      const methods = result.symbols.filter(s => s.kind === 'method');
      expect(methods).toHaveLength(1);
      expect(methods[0].name).toBe('MyStruct.helper');
    });
  });

  describe('Enum extraction', () => {
    it('extracts public enum', () => {
      const source = `
pub enum Status {
    Active,
    Inactive,
    Pending
}`;
      const result = parseFile(source, 'test.rs', 'rust');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('enum');
      expect(result.symbols[0].name).toBe('Status');
      expect(result.symbols[0].signature).toContain('pub enum Status');

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('Status');
    });

    it('extracts enum with variants', () => {
      const source = `
pub enum Result<T, E> {
    Ok(T),
    Err(E)
}`;
      const result = parseFile(source, 'test.rs', 'rust');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('enum');
      expect(result.symbols[0].name).toBe('Result');
    });
  });

  describe('Complex scenarios', () => {
    it('extracts all symbols from a complete module', () => {
      const source = `
use std::collections::HashMap;
use std::fmt::Display;

pub struct User {
    pub name: String,
    email: String
}

pub trait Repository {
    fn save(&self, user: &User) -> Result<(), String>;
}

impl User {
    pub fn new(name: String, email: String) -> Self {
        Self { name, email }
    }

    fn validate(&self) -> bool {
        !self.email.is_empty()
    }
}

impl Display for User {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{} <{}>", self.name, self.email)
    }
}

pub fn create_user(name: String, email: String) -> User {
    User::new(name, email)
}

pub enum Status {
    Active,
    Inactive
}
`;
      const result = parseFile(source, 'test.rs', 'rust');

      // Check imports
      expect(result.imports.length).toBeGreaterThanOrEqual(2);

      // Check symbols
      const struct_symbols = result.symbols.filter(s => s.kind === 'struct');
      expect(struct_symbols).toHaveLength(1);
      expect(struct_symbols[0].name).toBe('User');

      const trait_symbols = result.symbols.filter(s => s.kind === 'trait');
      expect(trait_symbols).toHaveLength(1);
      expect(trait_symbols[0].name).toBe('Repository');

      const methods = result.symbols.filter(s => s.kind === 'method');
      expect(methods.length).toBeGreaterThanOrEqual(3);

      const functions = result.symbols.filter(s => s.kind === 'function');
      expect(functions).toHaveLength(1);
      expect(functions[0].name).toBe('create_user');

      const enums = result.symbols.filter(s => s.kind === 'enum');
      expect(enums).toHaveLength(1);
      expect(enums[0].name).toBe('Status');

      // Check exports (only pub items)
      expect(result.exports.length).toBeGreaterThanOrEqual(5);
      const exportNames = result.exports.map(e => e.name);
      expect(exportNames).toContain('User');
      expect(exportNames).toContain('Repository');
      expect(exportNames).toContain('create_user');
      expect(exportNames).toContain('Status');
    });
  });
});
