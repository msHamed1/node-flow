import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { FullFlowInput } from '@mshamed1/node-flow-integration-contracts';
import { AuditListener } from './audit.listener.js';
import { IntegrationService } from './integration.service.js';

@Controller()
export class IntegrationController {
  constructor(
    private readonly integration: IntegrationService,
    private readonly auditListener: AuditListener,
  ) {}

  @Get('health')
  health(): Record<string, unknown> {
    return { ok: true, localEventsHandled: this.auditListener.handledCount() };
  }

  @Post('payments')
  createPayment(@Body() input: FullFlowInput): Promise<unknown> {
    return this.integration.fullFlow(input);
  }

  @Get('payments/:id')
  getPayment(@Param('id') id: string): Promise<unknown> {
    return this.integration.getPayment(id);
  }

  @Get('players/:id')
  getPlayer(@Param('id') id: string): Promise<Record<string, unknown>> {
    return this.integration.getPlayer(id);
  }

  @Post('integration/postgres')
  postgres(): Promise<unknown> {
    return this.integration.postgresOperations();
  }

  @Post('integration/mongoose')
  mongoose(): Promise<Record<string, unknown>> {
    return this.integration.mongooseOperations();
  }

  @Post('integration/redis')
  redis(): Promise<Record<string, unknown>> {
    return this.integration.redisOperations();
  }

  @Post('integration/rabbitmq')
  rabbitmq(): Promise<Record<string, unknown>> {
    return this.integration.rabbitmqOperations();
  }

  @Post('integration/http')
  http(@Query('fail') fail?: string): Promise<Record<string, unknown>> {
    return this.integration.httpOperations(fail === 'true');
  }

  @Post('integration/full-flow')
  fullFlow(@Body() input: FullFlowInput): Promise<Record<string, unknown>> {
    return this.integration.fullFlow(input);
  }
}
