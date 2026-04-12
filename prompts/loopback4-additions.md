# LoopBack4-Specific Review Additions

This prompt contains LoopBack4-specific review rules that are appended to the relevant review agents when the target framework is LoopBack4 or both LoopBack4 and Angular. These checks supplement the core review agents (code-quality, architecture, security, type-safety) with LoopBack4-specific patterns.

---

## Response Format

When these checks are applied, findings use the same JSON structure as the parent agent, with the `category` matching the parent agent's category (e.g., `"architecture"`, `"code-quality"`, `"security"`).

```json
{
  "findings": [
    {
      "severity": "critical|high|medium|low|nit",
      "category": "<parent-agent-category>",
      "file": "relative/path/to/file.ts",
      "line": 42,
      "title": "Short descriptive title",
      "description": "Detailed explanation of the issue and why it matters",
      "suggestion": "What should be done to fix this",
      "code_suggestion": "The actual corrected code (if applicable)"
    }
  ],
  "summary": "Brief summary of findings",
  "score": 7
}
```

---

## CRITICAL RULE: One Finding Per Violation

Create a SEPARATE finding for EACH individual violation. If a model has 12 properties and 8 are missing descriptions, that is 8 separate findings — one per property with its exact line number and complete `code_suggestion`.

---

## LoopBack4-Specific Checks

### 1. @model() Must Have Description — Severity: MEDIUM

Every `@model()` decorator MUST include a `description` in its settings. This is used for OpenAPI documentation and schema generation. Create a SEPARATE finding for EACH model missing a description.

**Bad:**
```typescript
// Missing model description — MEDIUM
@model()
export class Lead extends Entity {
  // ...
}

// Empty settings — MEDIUM
@model({})
export class Contact extends Entity {
  // ...
}
```

**Good:**
```typescript
@model({
  settings: {
    description: 'Represents a sales lead captured from various channels such as web forms, referrals, and marketing campaigns.',
  },
})
export class Lead extends Entity {
  // ...
}

@model({
  settings: {
    description: 'Represents a contact person associated with an account or lead.',
  },
})
export class Contact extends Entity {
  // ...
}
```

### 2. @property() Must Have Description — Severity: MEDIUM

EVERY `@property()` decorator MUST include a `description` field. This is critical for API documentation and consumer understanding. Create a SEPARATE finding for EACH property missing a description.

**Bad:**
```typescript
// Each missing description is a separate finding — MEDIUM
@property({
  type: 'string',
  id: true,
  generated: true,
})
id: string;

@property({
  type: 'string',
  required: true,
})
firstName: string;

@property({
  type: 'string',
  required: true,
})
lastName: string;

@property({
  type: 'string',
})
email?: string;

@property({
  type: 'date',
})
createdAt: Date;
```

The above would produce FIVE separate findings. Example for each:

**Finding for `id`:**
```json
{
  "severity": "medium",
  "category": "architecture",
  "file": "src/models/lead.model.ts",
  "line": 12,
  "title": "Missing description on @property() for id",
  "description": "The @property() decorator for 'id' is missing a description field. Every property must have a description for OpenAPI spec generation and API documentation.",
  "suggestion": "Add a description field to the @property() decorator.",
  "code_suggestion": "@property({\n  type: 'string',\n  id: true,\n  generated: true,\n  description: 'The unique auto-generated identifier for the lead.',\n})\nid: string;"
}
```

**Finding for `firstName`:**
```json
{
  "severity": "medium",
  "category": "architecture",
  "file": "src/models/lead.model.ts",
  "line": 18,
  "title": "Missing description on @property() for firstName",
  "description": "The @property() decorator for 'firstName' is missing a description field. Every property must have a description for OpenAPI spec generation and API documentation.",
  "suggestion": "Add a description field to the @property() decorator.",
  "code_suggestion": "@property({\n  type: 'string',\n  required: true,\n  description: 'The first name of the lead.',\n})\nfirstName: string;"
}
```

**Good:**
```typescript
@property({
  type: 'string',
  id: true,
  generated: true,
  description: 'The unique auto-generated identifier for the lead.',
})
id: string;

@property({
  type: 'string',
  required: true,
  description: 'The first name of the lead.',
})
firstName: string;

@property({
  type: 'string',
  required: true,
  description: 'The last name of the lead.',
})
lastName: string;

@property({
  type: 'string',
  description: 'The email address of the lead for primary contact.',
})
email?: string;

@property({
  type: 'date',
  description: 'The timestamp when the lead record was created.',
})
createdAt: Date;
```

### 3. @repository() Decorator Usage — Severity: MEDIUM

Repositories must use the `@repository()` decorator for proper DI registration. Flag repositories that are instantiated manually or missing the decorator.

**Bad:**
```typescript
// Manual instantiation — MEDIUM
class OrderService {
  private orderRepo = new OrderRepository(this.dataSource);
}
```

**Good:**
```typescript
class OrderService {
  constructor(
    @repository(OrderRepository)
    private orderRepository: OrderRepository,
  ) {}
}
```

### 4. Controller Decorators — Severity: MEDIUM

Controllers must have proper decorators for API documentation and routing.

Check for:
- Missing `@api()` decorator on the controller class
- Missing or incorrect `@get()`, `@post()`, `@put()`, `@patch()`, `@del()` decorators
- Missing response schema definitions in decorator options
- Missing endpoint description

**Bad:**
```typescript
// Missing decorators and schemas — MEDIUM
export class UserController {
  @get('/users')
  async find(): Promise<User[]> {
    return this.userRepository.find();
  }
}
```

**Good:**
```typescript
@api({ basePath: '/users' })
export class UserController {
  @get('/', {
    responses: {
      '200': {
        description: 'Array of User model instances',
        content: {
          'application/json': {
            schema: { type: 'array', items: getModelSchemaRef(User) },
          },
        },
      },
    },
  })
  async find(): Promise<User[]> {
    return this.userRepository.find();
  }
}
```

### 5. @param() and @requestBody() Mapping — Severity: MEDIUM

Every path parameter, query parameter, and request body must have proper decorators with type information.

**Bad:**
```typescript
// Missing param decorators — MEDIUM
@get('/users/{id}/orders')
async findOrders(id: string, status?: string): Promise<Order[]> {
  // Parameters not decorated — won't appear in OpenAPI spec
  return this.orderRepository.find({ where: { userId: id, status } });
}
```

**Good:**
```typescript
@get('/users/{id}/orders')
async findOrders(
  @param.path.string('id') id: string,
  @param.query.string('status') status?: string,
): Promise<Order[]> {
  return this.orderRepository.find({ where: { userId: id, status } });
}
```

### 6. HttpErrors Usage (Not Plain Error) — Severity: HIGH

In LoopBack4 code, NEVER throw plain `new Error(...)`. Always use `HttpErrors` from `@loopback/rest` for proper HTTP status codes and error formatting.

**Bad:**
```typescript
// Plain Error — HIGH
async findById(id: string): Promise<User> {
  const user = await this.userRepository.findOne({ where: { id } });
  if (!user) {
    throw new Error('User not found'); // Returns 500 instead of 404
  }
  return user;
}

// Generic Error for validation — HIGH
async createUser(data: CreateUserDto): Promise<User> {
  if (!data.email) {
    throw new Error('Email is required'); // Returns 500 instead of 400
  }
  return this.userRepository.create(data);
}
```

**Good:**
```typescript
import { HttpErrors } from '@loopback/rest';

async findById(id: string): Promise<User> {
  const user = await this.userRepository.findOne({ where: { id } });
  if (!user) {
    throw new HttpErrors.NotFound(`User with id '${id}' not found`);
  }
  return user;
}

async createUser(data: CreateUserDto): Promise<User> {
  if (!data.email) {
    throw new HttpErrors.BadRequest('Email is required');
  }
  return this.userRepository.create(data);
}
```

### 7. @authorize() on Protected Endpoints — Severity: HIGH

Every endpoint that modifies data or accesses sensitive information MUST have an `@authorize()` decorator with explicit role definitions. Create a SEPARATE finding for EACH unprotected endpoint.

**Bad:**
```typescript
// Missing authorization — HIGH
@put('/users/{id}')
async updateUser(
  @param.path.string('id') id: string,
  @requestBody() data: Partial<User>,
): Promise<User> {
  return this.userService.update(id, data);
}

// Missing authorization — HIGH
@del('/users/{id}')
async deleteUser(@param.path.string('id') id: string): Promise<void> {
  await this.userService.delete(id);
}
```

**Good:**
```typescript
@authorize({ allowedRoles: ['admin', 'self'] })
@put('/users/{id}')
async updateUser(
  @param.path.string('id') id: string,
  @requestBody() data: Partial<User>,
): Promise<User> {
  return this.userService.update(id, data);
}

@authorize({ allowedRoles: ['admin'] })
@del('/users/{id}')
async deleteUser(@param.path.string('id') id: string): Promise<void> {
  await this.userService.delete(id);
}
```

### 8. Interceptor Patterns — Severity: LOW to MEDIUM

- Global interceptors should be registered in the application class, not in individual controllers
- Request-scoped interceptors should use proper binding scope
- Interceptors should not contain business logic (use services)
- Interceptor order matters — verify execution order is correct

### 9. Model Relationships — Severity: MEDIUM

Check that relationship decorators (`@hasMany`, `@belongsTo`, `@hasOne`) are properly configured.

**Bad:**
```typescript
// Missing relationship configuration — MEDIUM
@hasMany(() => Order)
orders: Order[];
// Missing keyTo specification when not using default convention
```

**Good:**
```typescript
@hasMany(() => Order, { keyTo: 'customerId' })
orders: Order[];
```

### 10. @validate() Decorators — Severity: LOW

Model properties with business rules should use validation decorators to enforce constraints at the model level.

**Bad:**
```typescript
// No validation — LOW
@property({
  type: 'string',
  required: true,
  description: 'Email address of the user.',
})
email: string;
```

**Good:**
```typescript
@property({
  type: 'string',
  required: true,
  description: 'Email address of the user.',
  jsonSchema: {
    format: 'email',
    maxLength: 254,
  },
})
email: string;
```

### 11. Filter and Pagination Security — Severity: HIGH

LoopBack4 filters can be exploited if not properly restricted. Check for:

- Unrestricted `where` clause depth (potential NoSQL injection)
- Missing `limit` caps on find operations
- Unrestricted `include` depth (can expose entire database graph)
- Missing field restrictions on `fields` filter

**Bad:**
```typescript
// Unrestricted filter — HIGH
@get('/users')
async find(
  @param.filter(User) filter?: Filter<User>,
): Promise<User[]> {
  // Client can pass: { include: [{ relation: 'orders', scope: { include: [{ relation: 'items', scope: { include: [...] } }] } }] }
  return this.userRepository.find(filter);
}
```

**Good:**
```typescript
@get('/users')
async find(
  @param.query.number('limit') limit: number = 25,
  @param.query.number('skip') skip: number = 0,
  @param.query.string('orderBy') orderBy: string = 'createdAt',
): Promise<User[]> {
  const safeLimit = Math.min(limit, 100);
  return this.userRepository.find({
    limit: safeLimit,
    skip,
    order: [`${orderBy} DESC`],
    fields: { id: true, firstName: true, lastName: true, email: true },
  });
}
```

---

## Severity Summary

| Check | Severity |
|-------|----------|
| Missing @model() description | MEDIUM |
| Missing @property() description | MEDIUM |
| Plain Error instead of HttpErrors | HIGH |
| Missing @authorize() | HIGH |
| Unrestricted filters | HIGH |
| Missing @param/@requestBody | MEDIUM |
| Missing controller decorators | MEDIUM |
| Repository pattern violations | MEDIUM |
| Missing relationship config | MEDIUM |
| Interceptor issues | LOW-MEDIUM |
| Missing @validate() | LOW |

---

## Review Instructions

1. Identify all LoopBack4 model, controller, repository, and service files in the diff.
2. For EVERY `@model()` decorator, check for a `description` in settings. Create individual findings.
3. For EVERY `@property()` decorator, check for a `description` field. Create individual findings for EACH missing one.
4. Check every controller endpoint for `@authorize()` decorator.
5. Check every `throw` statement for proper HttpErrors usage.
6. Verify all endpoint parameters have `@param()` or `@requestBody()` decorators.
7. Check filter usage for security restrictions.
8. Verify model relationships are properly configured.
9. Create ONE finding per violation with the exact line number and a concrete `code_suggestion`.
10. Return valid JSON matching the parent agent's schema.
