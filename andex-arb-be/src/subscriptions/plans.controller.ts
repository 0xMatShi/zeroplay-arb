import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PlansService } from './plans.service';
import { PlanDto } from './dto/plan.dto';

@ApiTags('plans')
@Controller('plans')
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  @Get()
  @ApiOperation({ summary: 'Get all active subscription plans' })
  @ApiResponse({
    status: 200,
    description: 'Returns list of active plans',
    type: [PlanDto],
  })
  async findAll(): Promise<PlanDto[]> {
    return this.plansService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get plan by ID' })
  @ApiResponse({
    status: 200,
    description: 'Returns plan details',
    type: PlanDto,
  })
  @ApiResponse({ status: 404, description: 'Plan not found' })
  async findOne(@Param('id') id: string): Promise<PlanDto> {
    const plan = await this.plansService.findOne(id);
    if (!plan) {
      throw new NotFoundException('Plan not found');
    }
    return plan;
  }
}
