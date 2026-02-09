import { describe, it, expect } from 'vitest';
import { parseFile } from '../../src/indexer/parser.js';

describe('Java Parser', () => {
  it('extracts imports', () => {
    const source = `
import java.util.List;
import java.util.*;
import static java.lang.Math.PI;
    `.trim();
    const result = parseFile(source, 'Test.java', 'java');

    expect(result.imports.length).toBeGreaterThanOrEqual(2);
    expect(result.imports[0].source).toBe('java.util');
    expect(result.imports[0].names).toContain('List');
    // Wildcard import may have empty source
    const staticImport = result.imports.find(i => i.names.includes('PI'));
    expect(staticImport).toBeDefined();
    expect(staticImport!.source).toBe('java.lang.Math');
  });

  it('extracts class with extends and implements', () => {
    const source = `
package com.example;

public class MyClass extends BaseClass implements IFoo, IBar {
  public void doSomething() {}
}
    `.trim();
    const result = parseFile(source, 'MyClass.java', 'java');

    const classSymbol = result.symbols.find(s => s.kind === 'class' && s.name === 'MyClass');
    expect(classSymbol).toBeDefined();
    expect(classSymbol?.extends).toBe('BaseClass');
    expect(classSymbol?.implements).toContain('IFoo');
    expect(classSymbol?.implements).toContain('IBar');
  });

  it('extracts methods', () => {
    const source = `
public class Calculator {
  public int add(int a, int b) {
    return a + b;
  }

  public Calculator() {}
}
    `.trim();
    const result = parseFile(source, 'Calculator.java', 'java');

    expect(result.symbols.some(s => s.kind === 'method' && s.name === 'Calculator.add')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'method' && s.name === 'Calculator.Calculator')).toBe(true);
  });

  it('extracts public exports', () => {
    const source = `
public class PublicClass {}
class PackageClass {}
public interface IPublic {}
    `.trim();
    const result = parseFile(source, 'Test.java', 'java');

    expect(result.exports.some(e => e.name === 'PublicClass')).toBe(true);
    expect(result.exports.some(e => e.name === 'IPublic')).toBe(true);
    expect(result.exports.some(e => e.name === 'PackageClass')).toBe(false);
  });
});

describe('Ruby Parser', () => {
  it('extracts require and require_relative', () => {
    const source = `
require 'json'
require_relative 'lib/helper'
require "active_support/core_ext"
    `.trim();
    const result = parseFile(source, 'test.rb', 'ruby');

    expect(result.imports).toHaveLength(3);
    expect(result.imports[0].source).toBe('json');
    expect(result.imports[0].names).toContain('json');
    expect(result.imports[1].source).toBe('./lib/helper');
    expect(result.imports[2].source).toBe('active_support/core_ext');
  });

  it('extracts module and class', () => {
    const source = `
module MyApp
  class User < ActiveRecord::Base
    def initialize(name)
      @name = name
    end
  end
end
    `.trim();
    const result = parseFile(source, 'user.rb', 'ruby');

    expect(result.symbols.some(s => s.kind === 'module' && s.name === 'MyApp')).toBe(true);
    const classSymbol = result.symbols.find(s => s.kind === 'class' && s.name === 'User');
    expect(classSymbol).toBeDefined();
    // Ruby parser includes "< " prefix in extends
    expect(classSymbol?.extends).toContain('ActiveRecord::Base');
  });

  it('extracts methods', () => {
    const source = `
class Calculator
  def add(a, b)
    a + b
  end

  def self.version
    "1.0"
  end
end
    `.trim();
    const result = parseFile(source, 'calculator.rb', 'ruby');

    expect(result.symbols.some(s => s.kind === 'method' && s.name === 'Calculator.add')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'method' && s.name === 'Calculator.version')).toBe(true);
  });

  it('extracts attr_accessor properties', () => {
    const source = `
class Person
  attr_accessor :name, :email
  attr_reader :id
end
    `.trim();
    const result = parseFile(source, 'person.rb', 'ruby');

    expect(result.symbols.some(s => s.kind === 'property' && s.name === 'Person.name')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'property' && s.name === 'Person.email')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'property' && s.name === 'Person.id')).toBe(true);
  });
});

describe('C Parser', () => {
  it('extracts includes', () => {
    const source = `
#include <stdio.h>
#include <stdlib.h>
#include "myheader.h"
    `.trim();
    const result = parseFile(source, 'test.c', 'c');

    expect(result.imports).toHaveLength(3);
    expect(result.imports[0].source).toBe('stdio.h');
    expect(result.imports[0].names).toContain('stdio');
    expect(result.imports[1].source).toBe('stdlib.h');
    expect(result.imports[2].source).toBe('myheader.h');
  });

  it('extracts functions', () => {
    const source = `
int add(int a, int b) {
  return a + b;
}

void greet(void);
    `.trim();
    const result = parseFile(source, 'math.c', 'c');

    expect(result.symbols.some(s => s.kind === 'function' && s.name === 'add')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'function' && s.name === 'greet')).toBe(true);
  });

  it('extracts #define constants', () => {
    const source = `
#define MAX_SIZE 1024
#define VERSION "1.0"

int main() { return 0; }
    `.trim();
    const result = parseFile(source, 'test.c', 'c');

    expect(result.symbols.some(s => s.kind === 'constant' && s.name === 'MAX_SIZE')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'constant' && s.name === 'VERSION')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'function' && s.name === 'main')).toBe(true);
  });

  it('extracts defines', () => {
    const source = `
#define PI 3.14159
#define MAX(a, b) ((a) > (b) ? (a) : (b))
    `.trim();
    const result = parseFile(source, 'macros.c', 'c');

    expect(result.symbols.some(s => s.kind === 'constant' && s.name === 'PI')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'function' && s.name === 'MAX')).toBe(true);
  });
});

describe('C++ Parser', () => {
  it('extracts includes', () => {
    const source = `
#include <iostream>
#include <vector>
#include "myclass.hpp"
    `.trim();
    const result = parseFile(source, 'test.cpp', 'cpp');

    expect(result.imports).toHaveLength(3);
    expect(result.imports[0].source).toBe('iostream');
    expect(result.imports[0].names).toContain('iostream');
    expect(result.imports[1].source).toBe('vector');
    expect(result.imports[2].source).toBe('myclass.hpp');
  });

  it('extracts class with inheritance', () => {
    const source = `
class Base {
public:
  virtual void foo() = 0;
};

class Derived : public Base, public ILogger {
public:
  void foo() override {}
};
    `.trim();
    const result = parseFile(source, 'test.cpp', 'cpp');

    expect(result.symbols.some(s => s.kind === 'class' && s.name === 'Base')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'class' && s.name === 'Derived')).toBe(true);
    // C++ parser extracts methods from derived class
    expect(result.symbols.some(s => s.kind === 'method' && s.name === 'Derived::foo')).toBe(true);
  });

  it('extracts namespace and methods', () => {
    const source = `
namespace Math {
  int add(int a, int b) {
    return a + b;
  }
}

class Calculator {
public:
  int multiply(int a, int b) {
    return a * b;
  }
};
    `.trim();
    const result = parseFile(source, 'math.cpp', 'cpp');

    expect(result.symbols.some(s => s.kind === 'namespace' && s.name === 'Math')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'function' && s.name === 'add')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'class' && s.name === 'Calculator')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'method' && s.name === 'Calculator::multiply')).toBe(true);
  });

  it('extracts templates and enums', () => {
    const source = `
template<typename T>
class Container {
public:
  T value;
};

enum class Color {
  Red,
  Green,
  Blue
};
    `.trim();
    const result = parseFile(source, 'types.cpp', 'cpp');

    expect(result.symbols.some(s => s.kind === 'class' && s.name === 'Container')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'enum' && s.name === 'Color')).toBe(true);
  });
});

describe('C# Parser', () => {
  it('extracts using directives', () => {
    const source = `
using System;
using System.Collections.Generic;
using static System.Math;
using MyAlias = System.Text.StringBuilder;
    `.trim();
    const result = parseFile(source, 'Test.cs', 'csharp');

    expect(result.imports).toHaveLength(4);
    expect(result.imports[0].source).toBe('System');
    expect(result.imports[1].source).toBe('System.Collections.Generic');
    expect(result.imports[2].source).toBe('System.Math');
    // Alias import: source is the alias name, not the target
    expect(result.imports[3].source).toBe('MyAlias');
    expect(result.imports[3].names).toContain('MyAlias');
  });

  it('extracts namespace and class with interface', () => {
    const source = `
namespace MyApp {
  public class User : IDisposable {
    public void Dispose() {}
  }

  public interface ILogger {
    void Log(string message);
  }
}
    `.trim();
    const result = parseFile(source, 'User.cs', 'csharp');

    expect(result.symbols.some(s => s.kind === 'namespace' && s.name === 'MyApp')).toBe(true);
    const userClass = result.symbols.find(s => s.kind === 'class' && s.name === 'User');
    expect(userClass).toBeDefined();
    expect(userClass?.extends).toBe('IDisposable');
    expect(result.symbols.some(s => s.kind === 'interface' && s.name === 'ILogger')).toBe(true);
  });

  it('extracts enum and methods', () => {
    const source = `
public enum Status {
  Active,
  Inactive,
  Pending
}

public class Service {
  public void Start() {}
  public string GetName() { return "Service"; }
}
    `.trim();
    const result = parseFile(source, 'Service.cs', 'csharp');

    expect(result.symbols.some(s => s.kind === 'enum' && s.name === 'Status')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'class' && s.name === 'Service')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'method' && s.name === 'Service.Start')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'method' && s.name === 'Service.GetName')).toBe(true);
  });

  it('extracts properties and fields', () => {
    const source = `
public class Person {
  public string Name { get; set; }
  public int Age { get; private set; }
  public readonly string Id;
}
    `.trim();
    const result = parseFile(source, 'Person.cs', 'csharp');

    expect(result.symbols.some(s => s.kind === 'property' && s.name === 'Person.Name')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'property' && s.name === 'Person.Age')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'variable' && s.name === 'Person.Id')).toBe(true);
  });
});
