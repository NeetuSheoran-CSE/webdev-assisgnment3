const dns = require('dns');
// Local DNS (127.0.0.1) refuses SRV queries required by mongodb+srv://, so pin public DNS
dns.setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const Product = require('./models/Product');

const app = express();
app.use(express.json());

/* ------------------------- Helpers & Middleware ------------------------- */

// Wraps async handlers so errors go to the centralized error handler
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const httpError = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ALLOWED_FIELDS = ['name', 'sku', 'category', 'price', 'quantity', 'reorderLevel', 'supplier'];

// Validate :id is a proper MongoDB ObjectId
const validateObjectId = (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return next(httpError(`Invalid product id: ${req.params.id}`, 400));
  }
  next();
};

// Ensure body exists and keep only allowed product fields
const validateProductBody = (req, res, next) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return next(httpError('Request body must be a JSON object', 400));
  }
  const cleaned = {};
  ALLOWED_FIELDS.forEach((f) => {
    if (req.body[f] !== undefined) cleaned[f] = req.body[f];
  });
  if (Object.keys(cleaned).length === 0) {
    return next(httpError(`Provide at least one valid field: ${ALLOWED_FIELDS.join(', ')}`, 400));
  }
  req.body = cleaned;
  next();
};

// Validate body of PATCH /:id/stock
const validateStockBody = (req, res, next) => {
  const change = req.body && req.body.change;
  if (!Number.isInteger(change) || change === 0) {
    return next(httpError('"change" must be a non-zero integer (positive = restock, negative = sale)', 400));
  }
  next();
};

/* ------------------------------- Routes -------------------------------- */

app.get('/', (req, res) => res.json({ message: 'Inventory Management API is running' }));

// Low-Stock Alert Report: quantity <= reorderLevel (declared before /:id)
app.get('/api/products/low-stock', asyncHandler(async (req, res) => {
  const items = await Product.aggregate([
    { $match: { $expr: { $lte: ['$quantity', '$reorderLevel'] } } },
    { $sort: { quantity: 1 } },
  ]);
  const lowStockItems = items.map((p) => ({ ...p, stockValue: p.price * p.quantity, id: p._id }));
  res.status(200).json({ count: lowStockItems.length, lowStockItems });
}));

// Category-wise Inventory Summary (Aggregation)
app.get('/api/products/summary', asyncHandler(async (req, res) => {
  const summary = await Product.aggregate([
    {
      $group: {
        _id: '$category',
        totalItems: { $sum: 1 },
        totalQuantity: { $sum: '$quantity' },
        totalStockValue: { $sum: { $multiply: ['$price', '$quantity'] } },
        avgPrice: { $avg: '$price' },
      },
    },
    { $sort: { totalStockValue: -1 } },
  ]);
  res.status(200).json({ categories: summary.length, summary });
}));

// Create Product
app.post('/api/products', validateProductBody, asyncHandler(async (req, res) => {
  const product = await Product.create(req.body);
  res.status(201).json(product);
}));

// Get All Products - filtering, sorting, pagination
app.get('/api/products', asyncHandler(async (req, res) => {
  const { category, supplier, search, minPrice, maxPrice, inStock, sort, page, limit } = req.query;

  // Filtering
  const filter = {};
  if (category) filter.category = new RegExp(`^${escapeRegex(category)}$`, 'i');
  if (supplier) filter.supplier = new RegExp(`^${escapeRegex(supplier)}$`, 'i');
  if (search) filter.name = new RegExp(escapeRegex(search), 'i');
  if (minPrice !== undefined || maxPrice !== undefined) {
    filter.price = {};
    if (minPrice !== undefined) {
      if (isNaN(minPrice)) throw httpError('minPrice must be a number', 400);
      filter.price.$gte = Number(minPrice);
    }
    if (maxPrice !== undefined) {
      if (isNaN(maxPrice)) throw httpError('maxPrice must be a number', 400);
      filter.price.$lte = Number(maxPrice);
    }
  }
  if (inStock === 'true') filter.quantity = { $gt: 0 };
  if (inStock === 'false') filter.quantity = 0;

  // Sorting: ?sort=price,-quantity  ("-" = descending)
  const sortBy = sort ? sort.split(',').join(' ') : '-createdAt';

  // Pagination
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);

  const [total, products] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter).sort(sortBy).skip((pageNum - 1) * limitNum).limit(limitNum),
  ]);

  res.status(200).json({
    total,
    page: pageNum,
    totalPages: Math.ceil(total / limitNum),
    count: products.length,
    products,
  });
}));

// Restock / Sale: body { "change": 10 } or { "change": -3 }
app.patch('/api/products/:id/stock', validateObjectId, validateStockBody, asyncHandler(async (req, res) => {
  const { change } = req.body;

  // Atomic: for a sale, only match if enough stock exists (never goes negative)
  const filter = { _id: req.params.id };
  if (change < 0) filter.quantity = { $gte: Math.abs(change) };

  const product = await Product.findOneAndUpdate(filter, { $inc: { quantity: change } }, { new: true });

  if (!product) {
    const exists = await Product.findById(req.params.id).select('quantity');
    if (!exists) throw httpError('Product not found', 404);
    throw httpError(`Insufficient stock: available ${exists.quantity}, requested ${Math.abs(change)}`, 400);
  }
  res.status(200).json({ message: 'Stock updated', product });
}));

// Get Single Product
app.get('/api/products/:id', validateObjectId, asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw httpError('Product not found', 404);
  res.status(200).json(product);
}));

// Update Product Details
app.put('/api/products/:id', validateObjectId, validateProductBody, asyncHandler(async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!product) throw httpError('Product not found', 404);
  res.status(200).json(product);
}));

// Delete Product
app.delete('/api/products/:id', validateObjectId, asyncHandler(async (req, res) => {
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) throw httpError('Product not found', 404);
  res.status(200).json({ message: 'Product deleted', id: product.id });
}));

/* -------------------------- Error Handling ----------------------------- */

// 404 for unknown routes
app.use((req, res, next) => next(httpError(`Route not found: ${req.method} ${req.originalUrl}`, 404)));

// Centralized error handler
app.use((err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Server error';
  let errors;

  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = 'Validation failed';
    errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
  } else if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid value for ${err.path}: ${err.value}`;
  } else if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0];
    message = `Duplicate value for ${field}: "${err.keyValue[field]}" already exists`;
  } else if (err.type === 'entity.parse.failed') {
    statusCode = 400;
    message = 'Invalid JSON in request body';
  }

  if (statusCode === 500) console.error(err);
  res.status(statusCode).json({ success: false, message, ...(errors && { errors }) });
});

/* ------------------------------ Startup -------------------------------- */

const PORT = process.env.PORT || 5000;

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB connected');
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
