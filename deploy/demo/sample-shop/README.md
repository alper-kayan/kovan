# sample-shop

A small shopping cart for trying Kovan's agents on: prices are in cents, and every function has
a test (`npm test`, Node's own test runner, no dependencies).

- `src/cart.js`: add and remove items, count them, the subtotal.
- `src/money.js`: format cents as a price.

Ideas for an agent: discount codes, a tax rate, free shipping over an amount, the median item
price, a cart that refuses negative quantities.
