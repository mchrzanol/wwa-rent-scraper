-- CreateEnum
CREATE TYPE "ParkingType" AS ENUM ('PARKING', 'GARAGE');

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "parking" "ParkingType",
ADD COLUMN     "parkingFee" INTEGER;
