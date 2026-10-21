import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

@Entity('package_repository_members')
@Index('idx_package_repository_members_virtual_id_position', ['virtualId', 'position'])
@Index('uq_package_repository_members_virtual_id_member_id', ['virtualId', 'memberId'], { unique: true })
export class PackageRepositoryMember {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_package_repository_members' })
  id!: string;

  @Column({ name: 'virtual_id', type: 'uuid' })
  virtualId!: string;

  @Column({ name: 'member_id', type: 'uuid' })
  memberId!: string;

  @Column({ type: 'int', default: 0 })
  position!: number;
}
