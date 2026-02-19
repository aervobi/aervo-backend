const pkg = require('@shopify/shopify-api');
console.log('keys:', Object.keys(pkg));
console.log('Shopify present:', !!pkg.Shopify);
console.log('Context present:', !!(pkg.Shopify && pkg.Shopify.Context));
console.log('ApiVersion present:', !!pkg.ApiVersion);
console.log('Shopify keys:', Object.keys(pkg.Shopify || {}));
ldk