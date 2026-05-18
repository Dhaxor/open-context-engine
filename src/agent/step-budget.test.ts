import { describe, it, expect } from "vitest";
import { StepBudget } from "./step-budget";

describe("StepBudget", () => {
  it("classifies simple queries with lower budget", () => {
    const budget = new StepBudget("what is the main function?");
    let steps = 0;
    while (budget.shouldContinue()) steps++;
    expect(steps).toBe(8);
  });

  it("classifies complex queries with higher budget", () => {
    const budget = new StepBudget("refactor the authentication system to use JWT tokens");
    let steps = 0;
    while (budget.shouldContinue()) steps++;
    expect(steps).toBe(15);
  });

  it("detects loops and prevents continuation", () => {
    const budget = new StepBudget("find the bug");
    const args = { information_request: "bug in auth" };
    budget.shouldContinue("search", args);
    budget.shouldContinue("search", args);
    expect(budget.isLooping("search", args)).toBe(true);
    expect(budget.shouldContinue("search", args)).toBe(false);
  });

  it("allows extension when productive", () => {
    const budget = new StepBudget("what is X?", { baseSimple: 3, maxBudget: 25 });
    budget.shouldContinue();
    budget.shouldContinue();
    budget.shouldContinue();
    expect(budget.getRemaining()).toBe(0);
    const extended = budget.requestExtension(500);
    expect(extended).toBe(true);
    expect(budget.getRemaining()).toBe(5);
  });

  it("refuses extension for short results", () => {
    const budget = new StepBudget("what is X?", { baseSimple: 2, maxBudget: 25 });
    budget.shouldContinue();
    budget.shouldContinue();
    const extended = budget.requestExtension(50);
    expect(extended).toBe(false);
  });

  it("caps extensions at maxBudget", () => {
    const budget = new StepBudget("what is X?", { baseSimple: 22, maxBudget: 25, extensionSize: 5 });
    for (let i = 0; i < 22; i++) budget.shouldContinue();
    const first = budget.requestExtension(500);
    expect(first).toBe(false);
  });

  it("long queries are classified as complex", () => {
    const longQuery = "I need you to look at the entire authentication flow " +
      "from login to token refresh to logout, analyze how it handles edge cases " +
      "like expired tokens and concurrent requests, and suggest improvements " +
      "for both security and performance across all relevant files";
    const budget = new StepBudget(longQuery);
    let steps = 0;
    while (budget.shouldContinue()) steps++;
    expect(steps).toBe(15);
  });
});
