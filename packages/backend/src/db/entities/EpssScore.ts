import { Column, Entity, PrimaryColumn } from 'typeorm';

/** FIRST EPSS, one row per CVE. Replaced as a whole by each daily sync. */
@Entity('epss_scores')
export class EpssScore {
  @PrimaryColumn({ name: 'cve_id', type: 'varchar', length: 32, primaryKeyConstraintName: 'pk_epss_scores' })
  cveId!: string;

  @Column({ type: 'real' })
  score!: number;

  @Column({ type: 'real' })
  percentile!: number;
}
