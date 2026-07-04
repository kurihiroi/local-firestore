import type {
  AggregateRequest,
  AggregateResponse,
  ErrorResponse,
  QueryRequest,
  QueryResponse,
} from "@local-firestore/shared";
import { Hono } from "hono";
import type { IndexManager } from "../services/index-manager.js";
import type { QueryService } from "../services/query.js";
import { QueryValidationError } from "../services/query.js";
import { isCollectionPath } from "../utils/path.js";

export function createQueryRoutes(queryService: QueryService, indexManager?: IndexManager): Hono {
  const app = new Hono();

  // POST /query - クエリ実行
  app.post("/query", async (c) => {
    const body = await c.req.json<QueryRequest>();

    if (!body.collectionGroup && !isCollectionPath(body.collectionPath)) {
      return c.json<ErrorResponse>(
        { code: "invalid-argument", message: "Invalid collection path" },
        400,
      );
    }

    if (indexManager) {
      const validation = indexManager.validateQuery(body.collectionPath, body.constraints ?? []);
      if (!validation.valid) {
        return c.json<ErrorResponse>(
          {
            code: "failed-precondition",
            message: validation.message ?? "Missing composite index",
          },
          400,
        );
      }
    }

    let results: ReturnType<QueryService["executeQuery"]>;
    try {
      results = queryService.executeQuery(
        body.collectionPath,
        body.constraints,
        body.collectionGroup,
      );
    } catch (err) {
      if (err instanceof QueryValidationError) {
        return c.json<ErrorResponse>({ code: err.code, message: err.message }, 400);
      }
      throw err;
    }

    const response: QueryResponse = {
      docs: results.map((doc) => ({
        path: doc.path,
        data: doc.data,
        createTime: doc.createTime,
        updateTime: doc.updateTime,
      })),
    };

    return c.json(response);
  });

  // POST /aggregate - 集計クエリ実行
  app.post("/aggregate", async (c) => {
    const body = await c.req.json<AggregateRequest>();

    if (!body.collectionGroup && !isCollectionPath(body.collectionPath)) {
      return c.json<ErrorResponse>(
        { code: "invalid-argument", message: "Invalid collection path" },
        400,
      );
    }

    if (!body.aggregateSpec || Object.keys(body.aggregateSpec).length === 0) {
      return c.json<ErrorResponse>(
        { code: "invalid-argument", message: "aggregateSpec must have at least one field" },
        400,
      );
    }

    if (indexManager) {
      const validation = indexManager.validateQuery(body.collectionPath, body.constraints ?? []);
      if (!validation.valid) {
        return c.json<ErrorResponse>(
          {
            code: "failed-precondition",
            message: validation.message ?? "Missing composite index",
          },
          400,
        );
      }
    }

    const data = queryService.executeAggregate(
      body.collectionPath,
      body.constraints,
      body.aggregateSpec,
      body.collectionGroup,
    );

    const response: AggregateResponse = { data };
    return c.json(response);
  });

  return app;
}
