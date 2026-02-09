import { describe, it, expect } from 'vitest';
import { parseFile } from '../../src/indexer/parser.js';

describe('Go Parser', () => {
  describe('Imports', () => {
    it('extracts single import', () => {
      const source = `package main\n\nimport "fmt"`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('fmt');
      expect(result.imports[0].names).toContain('fmt');
      expect(result.imports[0].isDefault).toBe(true);
    });

    it('extracts grouped imports', () => {
      const source = `package main\n\nimport (\n\t"fmt"\n\t"os"\n)`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.imports).toHaveLength(2);
      expect(result.imports[0].source).toBe('fmt');
      expect(result.imports[0].names).toContain('fmt');
      expect(result.imports[1].source).toBe('os');
      expect(result.imports[1].names).toContain('os');
    });

    it('extracts import with alias', () => {
      const source = `package main\n\nimport myfmt "fmt"`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('fmt');
      expect(result.imports[0].names).toContain('myfmt');
      expect(result.imports[0].isDefault).toBe(true);
    });

    it('extracts dot import', () => {
      const source = `package main\n\nimport . "fmt"`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('fmt');
      expect(result.imports[0].isNamespace).toBe(true);
    });

    it('extracts blank import', () => {
      const source = `package main\n\nimport _ "fmt"`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('fmt');
      expect(result.imports[0].names).toContain('_');
    });
  });

  describe('Struct declarations', () => {
    it('extracts struct declaration', () => {
      const source = `package main\n\ntype User struct {\n\tID int\n\tName string\n}`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('struct');
      expect(result.symbols[0].name).toBe('User');
      expect(result.symbols[0].signature).toContain('User struct');
    });

    it('extracts struct with embedded type', () => {
      const source = `package main\n\ntype Admin struct {\n\tUser\n\tPermissions []string\n}`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('struct');
      expect(result.symbols[0].name).toBe('Admin');
      expect(result.symbols[0].extends).toBe('User');
    });

    it('marks exported struct in exports', () => {
      const source = `package main\n\ntype User struct {\n\tID int\n}`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('User');
      expect(result.exports[0].isDefault).toBe(false);
    });
  });

  describe('Interface declarations', () => {
    it('extracts interface declaration', () => {
      const source = `package main\n\ntype Service interface {\n\tStart() error\n\tStop()\n}`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('interface');
      expect(result.symbols[0].name).toBe('Service');
      expect(result.symbols[0].signature).toContain('Service interface');
    });
  });

  describe('Function declarations', () => {
    it('extracts function declaration', () => {
      const source = `package main\n\nfunc NewUser(id int, name string) *User {\n\treturn &User{ID: id, Name: name}\n}`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('function');
      expect(result.symbols[0].name).toBe('NewUser');
      expect(result.symbols[0].signature).toContain('func NewUser');
    });

    it('marks exported function in exports', () => {
      const source = `package main\n\nfunc NewUser() *User { return nil }`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('NewUser');
    });

    it('does not export unexported function', () => {
      const source = `package main\n\nfunc newUser() *User { return nil }`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.exports).toHaveLength(0);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('newUser');
    });
  });

  describe('Method declarations', () => {
    it('extracts method with pointer receiver', () => {
      const source = `package main\n\nfunc (s *Service) Start() error {\n\treturn nil\n}`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('method');
      expect(result.symbols[0].name).toBe('Service.Start');
      expect(result.symbols[0].signature).toContain('func (s *Service) Start');
    });

    it('extracts method with value receiver', () => {
      const source = `package main\n\nfunc (s Service) Stop() {\n\t// stop\n}`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('method');
      expect(result.symbols[0].name).toBe('Service.Stop');
      expect(result.symbols[0].signature).toContain('func (s Service) Stop');
    });

    it('marks exported method in exports', () => {
      const source = `package main\n\nfunc (s *Service) Start() error { return nil }`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('Service.Start');
    });

    it('does not export unexported method', () => {
      const source = `package main\n\nfunc (s *Service) stop() { }`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.exports).toHaveLength(0);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Service.stop');
    });
  });

  describe('Type aliases', () => {
    it('extracts type alias', () => {
      const source = `package main\n\ntype UserID int`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('type');
      expect(result.symbols[0].name).toBe('UserID');
    });
  });

  describe('Constants and variables', () => {
    it('extracts constant declaration', () => {
      const source = `package main\n\nconst MaxUsers = 100`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('constant');
      expect(result.symbols[0].name).toBe('MaxUsers');
    });

    it('extracts variable declaration', () => {
      const source = `package main\n\nvar DefaultUser *User`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].kind).toBe('variable');
      expect(result.symbols[0].name).toBe('DefaultUser');
    });
  });

  describe('Position tracking', () => {
    it('tracks symbol position', () => {
      const source = `package main\n\ntype User struct {\n\tID int\n}`;
      const result = parseFile(source, 'test.go', 'go');

      expect(result.symbols[0].startLine).toBe(3);
      expect(result.symbols[0].endLine).toBe(5);
    });
  });
});
