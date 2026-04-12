# Angular-Specific Review Additions

This prompt contains Angular-specific review rules that are appended to the relevant review agents when the target framework is Angular or both Angular and LoopBack4. These checks supplement the core review agents (code-quality, architecture, performance, type-safety) with Angular-specific patterns.

---

## Response Format

When these checks are applied, findings use the same JSON structure as the parent agent, with the `category` matching the parent agent's category (e.g., `"architecture"`, `"performance"`, `"code-quality"`).

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

Create a SEPARATE finding for EACH individual violation. Never batch multiple violations into one finding.

---

## Angular-Specific Checks

### 1. ChangeDetectionStrategy.OnPush — Severity: MEDIUM

Every component MUST use `ChangeDetectionStrategy.OnPush`. Default change detection runs on every event and is expensive. OnPush only checks when inputs change, an event fires from the template, or an Observable emits via the `async` pipe.

**Bad:**
```typescript
// Missing OnPush — MEDIUM
@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
})
export class DashboardComponent { /* ... */ }
```

**Good:**
```typescript
@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardComponent { /* ... */ }
```

### 2. RxJS Operator Selection — Severity: MEDIUM to HIGH

Using the wrong flattening operator causes subtle bugs:

| Operator | Use When | Behavior |
|----------|----------|----------|
| `switchMap` | Only the latest emission matters (search, navigation) | Cancels previous inner observable |
| `mergeMap` | All emissions should complete (parallel requests) | Runs all concurrently |
| `concatMap` | Order matters (sequential writes) | Queues emissions |
| `exhaustMap` | Ignore new while busy (form submit, button click) | Drops emissions while active |

**Bad:**
```typescript
// mergeMap for search — can cause race conditions — HIGH
this.searchInput.valueChanges.pipe(
  mergeMap(term => this.searchService.search(term)),
).subscribe(results => this.results = results);

// switchMap for form submit — can lose submissions — HIGH
this.submitForm$.pipe(
  switchMap(form => this.formService.submit(form)),
).subscribe();
```

**Good:**
```typescript
// switchMap for search — cancels stale requests
this.searchInput.valueChanges.pipe(
  debounceTime(300),
  distinctUntilChanged(),
  switchMap(term => this.searchService.search(term)),
).subscribe(results => this.results = results);

// exhaustMap for form submit — prevents duplicate submissions
this.submitForm$.pipe(
  exhaustMap(form => this.formService.submit(form)),
).subscribe();
```

### 3. Observable Composition — Avoid Nested subscribe() — Severity: HIGH

Nested `subscribe()` calls create memory leaks, lose error handling, and are impossible to cancel properly.

**Bad:**
```typescript
// Nested subscribe — HIGH
this.route.params.subscribe(params => {
  this.userId = params['id'];
  this.userService.getUser(this.userId).subscribe(user => {
    this.user = user;
    this.orderService.getOrders(user.id).subscribe(orders => {
      this.orders = orders;
    });
  });
});
```

**Good:**
```typescript
// Composed with operators
this.route.params.pipe(
  map(params => params['id']),
  switchMap(userId => this.userService.getUser(userId)),
  switchMap(user => {
    this.user = user;
    return this.orderService.getOrders(user.id);
  }),
  takeUntil(this.destroy$),
).subscribe(orders => this.orders = orders);

// Or with combineLatest for parallel
this.route.params.pipe(
  map(params => params['id']),
  switchMap(userId => combineLatest([
    this.userService.getUser(userId),
    this.orderService.getOrders(userId),
  ])),
  takeUntil(this.destroy$),
).subscribe(([user, orders]) => {
  this.user = user;
  this.orders = orders;
});
```

### 4. Async Pipe Usage with Safe Navigation — Severity: MEDIUM

Prefer the `async` pipe over manual subscription for template data. Always use safe navigation (`?.`) or `@if` to handle the loading state.

**Bad:**
```typescript
// Manual subscription in component — MEDIUM
@Component({ /* ... */ })
export class UserComponent implements OnInit {
  user: User;

  ngOnInit(): void {
    this.userService.getUser(this.id).subscribe(user => {
      this.user = user;
    });
  }
}

// Template without safe navigation
// <div>{{ user.name }}</div>
```

**Good:**
```typescript
@Component({
  template: `
    @if (user$ | async; as user) {
      <div>{{ user.name }}</div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserComponent {
  user$ = this.userService.getUser(this.id);

  constructor(private userService: UserService) {}
}
```

### 5. Module Structure Best Practices — Severity: LOW to MEDIUM

- **Core Module**: Imported only once in `AppModule`. Contains singleton services, global interceptors, guards.
- **Shared Module**: Reusable components, directives, pipes. Imported by feature modules. Must NOT import feature modules.
- **Feature Modules**: One per feature area. Should be lazy loaded.

**Bad:**
```typescript
// Shared module importing feature module — MEDIUM
@NgModule({
  imports: [
    CommonModule,
    UserModule, // Feature module in shared module
  ],
  exports: [SharedButtonComponent, SharedTableComponent],
})
export class SharedModule {}
```

### 6. Lazy Loading Routes — Severity: MEDIUM

Feature modules should be lazy loaded to reduce initial bundle size.

**Bad:**
```typescript
// Eager loading feature module — MEDIUM
const routes: Routes = [
  {
    path: 'admin',
    component: AdminDashboardComponent, // Eagerly loaded
  },
];

// Or importing module directly
@NgModule({
  imports: [AdminModule], // Eagerly loaded
})
export class AppModule {}
```

**Good:**
```typescript
const routes: Routes = [
  {
    path: 'admin',
    loadChildren: () => import('./admin/admin.module').then(m => m.AdminModule),
  },
  // Or with standalone components (Angular 15+)
  {
    path: 'admin',
    loadComponent: () => import('./admin/admin.component').then(c => c.AdminComponent),
  },
];
```

### 7. Component Lifecycle Hooks — Severity: MEDIUM

- Do NOT put heavy logic in the constructor. Use `ngOnInit` for initialization.
- Implement `OnDestroy` when the component has subscriptions, timers, or event listeners.
- When using `ngOnChanges`, always check which `@Input` changed before acting.

**Bad:**
```typescript
// Heavy logic in constructor — MEDIUM
@Component({ /* ... */ })
export class ReportComponent {
  constructor(private reportService: ReportService) {
    // Heavy initialization in constructor
    this.reportService.loadAllReports().subscribe(reports => {
      this.reports = reports;
    });
  }
}

// ngOnChanges without checking which input changed — MEDIUM
ngOnChanges(changes: SimpleChanges): void {
  // Runs for ANY input change, even unrelated ones
  this.reloadData();
}
```

**Good:**
```typescript
@Component({ /* ... */ })
export class ReportComponent implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();

  constructor(private reportService: ReportService) {}

  ngOnInit(): void {
    this.reportService.loadAllReports()
      .pipe(takeUntil(this.destroy$))
      .subscribe(reports => this.reports = reports);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['reportType']) {
      this.reloadData();
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
```

### 8. Service Dependency Injection Scope — Severity: MEDIUM

- `providedIn: 'root'` — Singleton, shared across the entire app. Use for stateless services.
- Module-level provider — One instance per module. Use for module-scoped state.
- Component-level provider — New instance per component. Use for component-specific state.

**Bad:**
```typescript
// Stateful service as singleton — MEDIUM
@Injectable({ providedIn: 'root' })
export class FormStateService {
  private formData: any = {}; // Mutable state shared globally — stale data risk
}
```

**Good:**
```typescript
// Component-scoped stateful service
@Injectable()
export class FormStateService {
  private formData: FormData = {};
}

@Component({
  providers: [FormStateService], // New instance per component
})
export class EditFormComponent { /* ... */ }
```

### 9. Template Logic Complexity — Severity: MEDIUM

Move complex logic out of templates and into the component class. Templates should be declarative, not procedural.

**Bad:**
```html
<!-- Complex logic in template — MEDIUM -->
<div *ngIf="user && user.role === 'admin' && user.isActive && !user.isLocked && (user.permissions.includes('read') || user.permissions.includes('write'))">
  <span>{{ user.firstName + ' ' + user.lastName + (user.suffix ? ', ' + user.suffix : '') }}</span>
  <span>{{ user.salary * 12 * (1 + user.bonusRate / 100) | currency }}</span>
</div>
```

**Good:**
```typescript
// Component class
get isAuthorizedAdmin(): boolean {
  return this.user?.role === 'admin'
    && this.user.isActive
    && !this.user.isLocked
    && this.user.permissions.some(p => ['read', 'write'].includes(p));
}

get fullName(): string {
  const suffix = this.user.suffix ? `, ${this.user.suffix}` : '';
  return `${this.user.firstName} ${this.user.lastName}${suffix}`;
}

get annualCompensation(): number {
  return this.user.salary * 12 * (1 + this.user.bonusRate / 100);
}
```

```html
<!-- Clean template -->
@if (isAuthorizedAdmin) {
  <span>{{ fullName }}</span>
  <span>{{ annualCompensation | currency }}</span>
}
```

### 10. Signals Usage (Angular 16+) — Severity: NIT

For Angular 16+ projects, consider using Signals for state management instead of RxJS for synchronous reactive state. This is a forward-looking recommendation, not a hard requirement.

**Good (modern Angular):**
```typescript
@Component({
  template: `<div>{{ count() }}</div>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CounterComponent {
  count = signal(0);
  doubleCount = computed(() => this.count() * 2);

  increment(): void {
    this.count.update(c => c + 1);
  }
}
```

---

## Severity Summary

| Check | Severity |
|-------|----------|
| Nested subscribe() | HIGH |
| Wrong RxJS flattening operator | HIGH (when it causes bugs) |
| Missing OnPush | MEDIUM |
| Missing subscription cleanup | HIGH |
| Template complexity | MEDIUM |
| Eager loading feature modules | MEDIUM |
| Constructor initialization | MEDIUM |
| Service scope mismatch | MEDIUM |
| Missing async pipe usage | MEDIUM |
| Module structure violation | MEDIUM |
| Missing Signals | NIT |

---

## Review Instructions

1. Identify all Angular component, service, directive, and pipe files in the diff.
2. Check every component for OnPush change detection.
3. Check every subscription for proper cleanup (takeUntil, async pipe, takeUntilDestroyed).
4. Verify RxJS operator selection matches the use case.
5. Look for nested subscribe() calls.
6. Check template files for complex logic.
7. Verify lazy loading on feature module routes.
8. Check service injection scope for correctness.
9. Create ONE finding per violation with the exact line number and a concrete fix.
10. Return valid JSON matching the parent agent's schema.
