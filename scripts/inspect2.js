const pkg = require('@shopify/shopify-api');
console.log('shopifyApi keys:', Object.keys(pkg.shopifyApi || {}));
console.dir(pkg.shopifyApi, { depth: 1 });
