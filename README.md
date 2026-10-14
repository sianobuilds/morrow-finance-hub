# Morrow Finance Hub

Internal Accounts Payable management demonstration for
Morrow & Co., a fictional US lifestyle company.

## Start

npm start

Open http://localhost:3067

## AI

Create a .env file:

OPENAI_API_KEY=your_key_here

The start script loads the key before launching Node.js.

The OpenAI Responses API extracts structured invoice fields
from PDF, PNG and JPG files.

## Features

- Finance dashboard
- Invoice management
- Vision LLM extraction
- Invoice validation and duplicate detection
- Human review and approval workflow
- Supplier analytics
- Actual extraction latency and token tracking
- Audit history
- Approved invoice CSV/JSON export

## Limitations

This is a local portfolio demonstration.
Authentication, role-based access control, durable original
document storage, production-grade accounting integration,
and labeled accuracy benchmarking are not implemented.

Never use real confidential financial documents in this
development environment without appropriate security controls.
