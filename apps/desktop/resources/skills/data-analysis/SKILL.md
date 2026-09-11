---
name: Data analysis
description: Explore, clean, and draw conclusions from a dataset — profiling it, handling missing and malformed values, aggregating, and reporting findings honestly. Use when handed a CSV, spreadsheet, or query result and asked what it shows.
---

# Data analysis

## Profile before you analyse

Every wrong analysis starts with an assumption about the data that was never
checked:

```python
df.shape
df.dtypes
df.head(20)
df.isna().sum()
df.describe(include="all")
for c in df.select_dtypes("object"): print(c, df[c].nunique(), df[c].unique()[:8])
df.duplicated().sum()
```

What you are looking for: numeric columns typed as `object` (the tell for
numbers stored as text), dates as strings, categoricals with near-duplicate
values (`"NY"`, `"ny"`, `"New York"`), impossible values (negative ages, future
dates), and how much is missing.

## Missing data

Find out *why* it is missing before deciding what to do. Missing at random and
missing because the sensor was offline call for different handling — and
dropping rows silently changes the population you are describing.

Say what you did. "Dropped 1,204 rows (12%) with no timestamp" belongs in the
output, not just in the code.

## Aggregation

- Check group sizes before comparing group means. A "group" with three rows is
  noise, and it will produce the most extreme number in your table.
- Prefer the median for anything with a tail — income, latency, session length.
  A mean latency is almost always the wrong number to quote.
- After a join, **check the row count**. Growth means a many-to-many you did not
  expect; shrinkage means keys that did not match.

## Reporting honestly

- Correlation is not causation, and the confounder is usually obvious once
  named. Name it.
- Give the denominator. "40% increase" from 5 to 7 is not a finding.
- Report the uncertainty, or at least the sample size.
- State what would change the conclusion — that is what makes it useful rather
  than decorative.
- If the data cannot answer the question, say so. That is a legitimate and
  frequently correct result.

## Plotting

Label the axes, include units, and start bar charts at zero. Use a chart to show
a shape (trend, distribution, comparison); use a table for exact values. Do not
use both for the same numbers.
