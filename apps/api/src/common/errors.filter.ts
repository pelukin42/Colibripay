import {
  Catch,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ColibriError } from '@colibripay/shared';

/**
 * Traduce cualquier excepción a la forma de error de la API pública.
 *
 * El punto crítico es el caso por defecto: un error inesperado se registra
 * completo del lado servidor pero al cliente le llega un mensaje genérico. Una
 * traza de Postgres en el cuerpo de una respuesta le regala a un atacante el
 * esquema de la base.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = request.requestId;

    if (exception instanceof ColibriError) {
      // Errores de negocio: son esperados y no ensucian los logs de error.
      response.status(exception.statusCode).json(exception.toBody(requestId));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ?? exception.message);

      response.status(status).json({
        error: {
          type: status >= 500 ? 'api_error' : 'invalid_request_error',
          code: status === 404 ? 'resource_missing' : 'request_invalid',
          message: Array.isArray(message) ? message.join('; ') : message,
          ...(requestId ? { requestId } : {}),
        },
      });
      return;
    }

    this.logger.error(
      `Error no controlado [${requestId ?? 'sin-id'}] ${request.method} ${request.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    response.status(500).json(ColibriError.internal().toBody(requestId));
  }
}
