import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReserveModalComponent } from '../../shared/reserve-modal/reserve-modal';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [CommonModule, ReserveModalComponent],
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
})
export class LandingComponent {
  reserveOpen = false;

  openReserve(): void {
    this.reserveOpen = true;
  }

  closeReserve(): void {
    this.reserveOpen = false;
  }
}
