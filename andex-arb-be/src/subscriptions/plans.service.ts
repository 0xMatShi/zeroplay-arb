import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plan } from './entities/plan.entity';

@Injectable()
export class PlansService implements OnModuleInit {
  constructor(
    @InjectRepository(Plan)
    private readonly planRepository: Repository<Plan>,
  ) {}

  async onModuleInit() {
    await this.loadPredefinedPlans();
  }

  private async loadPredefinedPlans() {
    const predefinedPlans = [
      {
        name: 'Basic',
        description: 'Basic subscription plan with essential features',
        price: '9.99',
        durationDays: 30,
        isActive: true,
      },
      {
        name: 'Pro',
        description: 'Professional subscription plan with advanced features',
        price: '29.99',
        durationDays: 30,
        isActive: true,
      },
      {
        name: 'Enterprise',
        description: 'Enterprise subscription plan with all features',
        price: '99.99',
        durationDays: 30,
        isActive: true,
      },
    ];

    for (const planData of predefinedPlans) {
      const existingPlan = await this.planRepository.findOne({
        where: { name: planData.name },
      });

      if (existingPlan) {
        if (
          existingPlan.price !== planData.price ||
          existingPlan.durationDays !== planData.durationDays
        ) {
          existingPlan.price = planData.price;
          existingPlan.durationDays = planData.durationDays;
          await this.planRepository.save(existingPlan);
          console.log(`Updated plan: ${planData.name} (price: ${planData.price})`);
        }
      } else {
        await this.planRepository.save(planData);
        console.log(`Created plan: ${planData.name} (price: ${planData.price})`);
      }
    }
  }

  async findAll(): Promise<Plan[]> {
    return this.planRepository.find({
      where: { isActive: true },
      order: { createdAt: 'ASC' },
    });
  }

  async findOne(id: string): Promise<Plan | null> {
    return this.planRepository.findOne({
      where: { id, isActive: true },
    });
  }
}
