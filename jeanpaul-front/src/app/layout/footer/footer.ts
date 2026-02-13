import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-footer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './footer.html',
  styleUrl: './footer.scss',
})
export class Footer {
  year = new Date().getFullYear();

  phoneDisplay = '315 517 7272';
  address = 'Riohacha, Carrera 15 # 15 - 72, local 102';
  instagram = '@barberia_jeanpaul_vip';

  igUrl = 'https://instagram.com/barberia_jeanpaul_vip';
  waUrl = 'https://wa.me/573155177272';
}
